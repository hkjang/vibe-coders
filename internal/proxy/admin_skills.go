package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

var validSkillStatus = map[string]bool{"draft": true, "staging": true, "production": true, "deprecated": true}
var validSkillRisk = map[string]bool{"low": true, "medium": true, "high": true}

// skillActor returns the caller identity for skill audit/authorship.
func (s *Server) skillActor(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok && strings.TrimSpace(claims.Subject) != "" {
		return claims.Subject
	}
	return "admin"
}

// publicSkillView is the caller-facing projection (no owner/metadata internals beyond what's
// useful for discovery; instructions included so a client can apply the skill).
func publicSkillView(sk store.Skill, withInstructions bool) map[string]any {
	v := map[string]any{
		"name": sk.Name, "description": sk.Description, "version": sk.Version,
		"status": sk.Status, "risk_level": sk.RiskLevel,
	}
	if withInstructions {
		v["instructions"] = sk.Instructions
		v["allowed_models"] = sk.AllowedModels
		v["allowed_tools"] = sk.AllowedTools
		v["allowed_teams"] = sk.AllowedTeams
		v["daily_limit"] = sk.DailyLimit
	}
	return v
}

// handlePublicSkills serves the caller-facing skill catalog (production status only).
// GET /v1/skills        → list production skills (no instructions)
// GET /v1/skills/{name} → one production skill with instructions
func (s *Server) handlePublicSkills(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateProxy(r); !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "missing or invalid API key", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/skills"), "/")
	if name == "" {
		skills, err := s.db.ListSkills(r.Context(), "production")
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
			return
		}
		items := make([]map[string]any, 0, len(skills))
		for _, sk := range skills {
			items = append(items, publicSkillView(sk, false))
		}
		writeJSON(w, http.StatusOK, map[string]any{"skills": items})
		return
	}
	sk, found, err := s.db.GetSkill(r.Context(), name)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_failed")
		return
	}
	if !found || sk.Status != "production" {
		writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skill": publicSkillView(sk, true)})
}

type skillPayload struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Version       string          `json:"version"`
	Owner         string          `json:"owner"`
	Status        string          `json:"status"`
	RiskLevel     string          `json:"risk_level"`
	AllowedModels string          `json:"allowed_models"`
	AllowedTools  string          `json:"allowed_tools"`
	AllowedTeams  string          `json:"allowed_teams"`
	DailyLimit    int             `json:"daily_limit"`
	Instructions  string          `json:"instructions"`
	Metadata      json.RawMessage `json:"metadata"`
}

// handleSkills serves GET (admin list, all statuses) and POST (create/upsert).
// GET  /admin/skills?status=
// POST /admin/skills {name,description,version,owner,status,risk_level,allowed_models,allowed_tools,instructions,metadata}
func (s *Server) handleSkills(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		skills, err := s.db.ListSkills(r.Context(), strings.TrimSpace(r.URL.Query().Get("status")))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"skills": skills})
	case http.MethodPost:
		var p skillPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		status := strings.TrimSpace(p.Status)
		if status != "" && !validSkillStatus[status] {
			writeOpenAIError(w, http.StatusBadRequest, "status must be draft|staging|production|deprecated", "invalid_request_error", "invalid_status")
			return
		}
		risk := strings.TrimSpace(p.RiskLevel)
		if risk != "" && !validSkillRisk[risk] {
			writeOpenAIError(w, http.StatusBadRequest, "risk_level must be low|medium|high", "invalid_request_error", "invalid_risk")
			return
		}
		meta := strings.TrimSpace(string(p.Metadata))
		if meta == "" || meta == "null" {
			meta = "{}"
		}
		if !json.Valid([]byte(meta)) {
			writeOpenAIError(w, http.StatusBadRequest, "metadata must be valid JSON", "invalid_request_error", "invalid_metadata")
			return
		}
		saved, err := s.db.UpsertSkill(r.Context(), store.Skill{
			Name: name, Description: p.Description, Version: strings.TrimSpace(p.Version), Owner: strings.TrimSpace(p.Owner),
			Status: status, RiskLevel: risk, AllowedModels: strings.TrimSpace(p.AllowedModels), AllowedTools: strings.TrimSpace(p.AllowedTools),
			AllowedTeams: strings.TrimSpace(p.AllowedTeams), DailyLimit: p.DailyLimit, Instructions: p.Instructions, Metadata: meta,
		}, s.skillActor(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_save_failed")
			return
		}
		s.auditAdmin(r, "skill.upsert", saved.Name, auditJSON(map[string]any{"version": saved.Version, "status": saved.Status}))
		writeJSON(w, http.StatusCreated, map[string]any{"skill": saved})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleSkillByName serves GET/DELETE for one skill.
// GET|DELETE /admin/skills/by-name/{name}
func (s *Server) handleSkillByName(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/skills/by-name/"), "/")
	if name == "" {
		writeOpenAIError(w, http.StatusBadRequest, "skill name required", "invalid_request_error", "missing_name")
		return
	}
	switch r.Method {
	case http.MethodGet:
		sk, found, err := s.db.GetSkill(r.Context(), name)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"skill": sk})
	case http.MethodDelete:
		if err := s.db.DeleteSkill(r.Context(), name); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_delete_failed")
			return
		}
		s.auditAdmin(r, "skill.delete", name, "")
		writeJSON(w, http.StatusOK, map[string]any{"name": name, "deleted": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleSkillEvaluate dry-runs a skill's allowed_models/allowed_tools policy against a
// candidate model + tool set without making any upstream call — the policy-simulator
// equivalent for skills, so operators can preview what enforce mode would do.
// POST /admin/skills/evaluate {name, model, tools:[...]}
func (s *Server) handleSkillEvaluate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Name  string   `json:"name"`
		Model string   `json:"model"`
		Tools []string `json:"tools"`
		Team  string   `json:"team"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	name := strings.TrimSpace(p.Name)
	if name == "" {
		writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
		return
	}
	sk, found, err := s.db.GetSkill(r.Context(), name)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
		return
	}
	violations := evaluateSkillPolicy(sk, strings.TrimSpace(p.Model), p.Tools, strings.TrimSpace(p.Team))
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          sk.Name,
		"status":        sk.Status,
		"enforcement":   s.skillsConf().Enforcement,
		"production":    sk.Status == "production",
		"allowed":       len(violations) == 0,
		"violations":    violations,
		"would_block":   len(violations) > 0 && strings.EqualFold(s.skillsConf().Enforcement, "enforce"),
	})
}

// recommendedSkills are the three starter skills suggested in the Skills design — seeded as
// drafts so an operator can review, fill in instructions, and promote them to production.
var recommendedSkills = []store.Skill{
	{Name: "text2sql-safety-test-generator", Description: "Generate SELECT-only safety test cases for Text2SQL prompts.", RiskLevel: "medium", AllowedTools: "sql-runner", Status: "draft",
		Instructions: "Given a Text2SQL question, produce read-only test queries that probe row-limit, date-filter, and PII-masking behavior. Never emit INSERT/UPDATE/DELETE/DDL."},
	{Name: "prompt-regression-reviewer", Description: "Review prompt changes for regressions against golden prompts.", RiskLevel: "low", Status: "draft",
		Instructions: "Compare a candidate prompt against the registered golden prompt set and flag semantic drift, removed guardrails, or weakened constraints."},
	{Name: "mcp-tool-risk-classifier", Description: "Classify MCP/tool invocations into low/medium/high risk tiers.", RiskLevel: "high", Status: "draft",
		Instructions: "Given an MCP tool name and arguments, assign a risk tier and justification (filesystem write, network egress, credential access raise the tier)."},
}

// handleSkillSeedRecommended inserts the recommended starter skills (idempotent upsert).
// POST /admin/skills/seed-recommended
func (s *Server) handleSkillSeedRecommended(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	seeded := []string{}
	for _, sk := range recommendedSkills {
		if _, err := s.db.UpsertSkill(r.Context(), sk, s.skillActor(r)); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_seed_failed")
			return
		}
		seeded = append(seeded, sk.Name)
	}
	s.auditAdmin(r, "skill.seed_recommended", strings.Join(seeded, ","), "")
	writeJSON(w, http.StatusOK, map[string]any{"seeded": seeded})
}

// validSkillTransitions defines the allowed lifecycle moves for the promotion gate.
// Reaching production requires passing through staging first (no draft→production jump).
var validSkillTransitions = map[string]map[string]bool{
	"draft":      {"staging": true, "deprecated": true},
	"staging":    {"production": true, "draft": true, "deprecated": true},
	"production": {"staging": true, "deprecated": true},
	"deprecated": {"staging": true, "draft": true},
}

// skillPromotionGate returns the reason a transition is not allowed, or "" if it passes.
// Gate rules to production: instructions must be present (callers receive them); high-risk
// skills require a justification note.
func skillPromotionGate(sk store.Skill, toStatus, note string) string {
	from := strings.TrimSpace(sk.Status)
	if from == "" {
		from = "draft"
	}
	if from == toStatus {
		return "skill is already in status '" + toStatus + "'"
	}
	if allowed, ok := validSkillTransitions[from]; !ok || !allowed[toStatus] {
		return "transition " + from + " → " + toStatus + " is not allowed"
	}
	if toStatus == "production" {
		if strings.TrimSpace(sk.Instructions) == "" {
			return "a production skill must have non-empty instructions"
		}
		if sk.RiskLevel == "high" && strings.TrimSpace(note) == "" {
			return "high-risk skills require a justification note to reach production"
		}
	}
	return ""
}

// handleSkillPromote performs a governed lifecycle transition with gate checks + history.
// POST /admin/skills/promote {name, to_status, version, note}
func (s *Server) handleSkillPromote(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Name     string `json:"name"`
		ToStatus string `json:"to_status"`
		Version  string `json:"version"`
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	name := strings.TrimSpace(p.Name)
	to := strings.TrimSpace(p.ToStatus)
	if name == "" || to == "" {
		writeOpenAIError(w, http.StatusBadRequest, "name and to_status are required", "invalid_request_error", "missing_fields")
		return
	}
	if !validSkillStatus[to] {
		writeOpenAIError(w, http.StatusBadRequest, "to_status must be draft|staging|production|deprecated", "invalid_request_error", "invalid_status")
		return
	}
	sk, found, err := s.db.GetSkill(r.Context(), name)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
		return
	}
	if reason := skillPromotionGate(sk, to, p.Note); reason != "" {
		writeOpenAIError(w, http.StatusUnprocessableEntity, "promotion gate: "+reason, "invalid_request_error", "promotion_gate")
		return
	}
	// Security gate: a skill with high-severity scan findings cannot reach production.
	if to == "production" {
		if scan := scanSkillSecurity(sk); scan.HighCount > 0 {
			details := make([]string, 0, len(scan.Findings))
			for _, f := range scan.Findings {
				if f.Severity == "high" {
					details = append(details, f.Category+" ("+f.Detail+")")
				}
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": map[string]any{"message": "security gate: skill has high-severity findings: " + strings.Join(details, "; "), "type": "invalid_request_error", "code": "security_gate"},
				"scan":  scan,
			})
			return
		}
	}
	saved, err := s.db.PromoteSkill(r.Context(), name, to, strings.TrimSpace(p.Version), s.skillActor(r), strings.TrimSpace(p.Note))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_promote_failed")
		return
	}
	s.auditAdmin(r, "skill.promote", saved.Name, auditJSON(map[string]any{"from": sk.Status, "to": to, "version": saved.Version}))
	writeJSON(w, http.StatusOK, map[string]any{"skill": saved})
}

// handleSkillPromotions returns the promotion history (optionally for one skill).
// GET /admin/skills/promotions?skill=&limit=
func (s *Server) handleSkillPromotions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	proms, err := s.db.ListSkillPromotions(r.Context(), strings.TrimSpace(r.URL.Query().Get("skill")), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_promotions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"promotions": proms})
}

// skillBundle is the portable export/import format for skills (GitOps: version-control
// curated skills and move them between gateway deployments).
type skillBundle struct {
	Version string        `json:"version"`
	Skills  []store.Skill `json:"skills"`
}

// handleSkillExport returns a portable bundle of skills (optionally filtered by status).
// GET /admin/skills/export?status=
func (s *Server) handleSkillExport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	skills, err := s.db.ListSkills(r.Context(), strings.TrimSpace(r.URL.Query().Get("status")))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
		return
	}
	writeJSON(w, http.StatusOK, skillBundle{Version: AppVersion, Skills: skills})
}

// handleSkillImport upserts skills from a bundle (idempotent by name). The security gate is
// preserved: a skill imported as production with high-severity scan findings is skipped
// (reported), not silently published.
// POST /admin/skills/import {version, skills:[...]}
func (s *Server) handleSkillImport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var bundle skillBundle
	if err := json.NewDecoder(r.Body).Decode(&bundle); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	actor := s.skillActor(r)
	imported := []string{}
	skipped := []map[string]any{}
	for _, sk := range bundle.Skills {
		name := strings.TrimSpace(sk.Name)
		if name == "" {
			skipped = append(skipped, map[string]any{"name": "", "reason": "missing name"})
			continue
		}
		if sk.Status != "" && !validSkillStatus[sk.Status] {
			skipped = append(skipped, map[string]any{"name": name, "reason": "invalid status: " + sk.Status})
			continue
		}
		if sk.RiskLevel != "" && !validSkillRisk[sk.RiskLevel] {
			skipped = append(skipped, map[string]any{"name": name, "reason": "invalid risk_level: " + sk.RiskLevel})
			continue
		}
		meta := strings.TrimSpace(sk.Metadata)
		if meta != "" && meta != "{}" && !json.Valid([]byte(meta)) {
			skipped = append(skipped, map[string]any{"name": name, "reason": "invalid metadata JSON"})
			continue
		}
		// Security gate: never import a production skill that fails the scanner.
		if sk.Status == "production" {
			if scan := scanSkillSecurity(sk); scan.HighCount > 0 {
				skipped = append(skipped, map[string]any{"name": name, "reason": "security_gate: high-severity findings", "high_count": scan.HighCount})
				continue
			}
		}
		if _, err := s.db.UpsertSkill(r.Context(), sk, actor); err != nil {
			skipped = append(skipped, map[string]any{"name": name, "reason": err.Error()})
			continue
		}
		imported = append(imported, name)
	}
	s.auditAdmin(r, "skill.import", "", auditJSON(map[string]any{"imported": len(imported), "skipped": len(skipped)}))
	writeJSON(w, http.StatusOK, map[string]any{"imported": imported, "imported_count": len(imported), "skipped": skipped})
}

// handleSkillRecommend mines recurring Text2SQL questions (the report-candidate signal) and
// proposes draft skills that standardize answering them — the OKF self-improvement loop's
// Skill analogue. Dry-run by default; ?apply=1 creates the proposals as draft skills
// (idempotent, never production — a human reviews then promotes through the gated workflow).
// POST /admin/skills/recommend?window=&min_count=&apply=
func (s *Server) handleSkillRecommend(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := intQuery(r, "min_count", 3)
	apply := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("apply")), "1")

	cands, err := s.db.Text2SQLReportCandidates(r.Context(), since, minCount, 50)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommend_failed")
		return
	}
	existing, err := s.db.ListSkills(r.Context(), "")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
		return
	}
	have := map[string]bool{}
	for _, sk := range existing {
		have[sk.Name] = true
	}

	actor := s.skillActor(r)
	recs := []map[string]any{}
	for _, c := range cands {
		q := strings.TrimSpace(c.Question)
		if q == "" {
			continue
		}
		slug := okfSlug(q)
		if len(slug) > 40 {
			slug = strings.Trim(slug[:40], "-")
		}
		if slug == "" {
			continue
		}
		name := "answer-" + slug
		if have[name] {
			continue // already exists — don't re-propose
		}
		instr := "반복되는 질문 '" + q + "'에 답하는 표준 절차입니다."
		if strings.TrimSpace(c.SampleSQL) != "" {
			instr += "\n검증된 SQL 패턴:\n" + c.SampleSQL
		}
		rec := store.Skill{
			Name: name, Description: q, Status: "draft", RiskLevel: "low",
			Instructions: instr,
			Metadata:     auditJSON(map[string]any{"origin": "skill_recommender", "count": c.Count, "recommended_product": c.RecommendedProduct}),
		}
		entry := map[string]any{"name": name, "description": q, "count": c.Count, "recommended_product": c.RecommendedProduct, "applied": false}
		if apply {
			if _, err := s.db.UpsertSkill(r.Context(), rec, actor); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_recommend_apply_failed")
				return
			}
			have[name] = true
			entry["applied"] = true
		}
		recs = append(recs, entry)
	}
	if apply {
		s.auditAdmin(r, "skill.recommend_apply", "", auditJSON(map[string]any{"applied": len(recs)}))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recommendations": recs, "applied": apply, "count": len(recs),
		"note": "applied skills are status=draft — review, then promote through /admin/skills/promote (gated + scanned)",
	})
}

// handleSkillScan runs the security scanner over one skill (?name=) or all skills (no name).
// GET /admin/skills/scan?name=
func (s *Server) handleSkillScan(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name != "" {
		sk, found, err := s.db.GetSkill(r.Context(), name)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"name": sk.Name, "scan": scanSkillSecurity(sk)})
		return
	}
	skills, err := s.db.ListSkills(r.Context(), "")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
		return
	}
	items := make([]map[string]any, 0, len(skills))
	for _, sk := range skills {
		res := scanSkillSecurity(sk)
		items = append(items, map[string]any{
			"name": sk.Name, "status": sk.Status, "risk_level": sk.RiskLevel,
			"max_severity": res.MaxSeverity, "high_count": res.HighCount,
			"medium_count": res.MediumCount, "low_count": res.LowCount,
			"clean": res.Clean, "findings": res.Findings,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"scans": items})
}

// handleSkillStats returns per-skill execution aggregates over a time window — the
// observability/cost view: runs, ok/error/blocked counts, block rate, total cost, avg
// latency, distinct actors, last run.
// GET /admin/skills/stats?window=
func (s *Server) handleSkillStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	stats, err := s.db.SkillRunStats(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_stats_failed")
		return
	}
	items := make([]map[string]any, 0, len(stats))
	for _, st := range stats {
		blockRate := 0.0
		if st.Runs > 0 {
			blockRate = float64(st.Blocked) / float64(st.Runs)
		}
		items = append(items, map[string]any{
			"skill_name": st.SkillName, "runs": st.Runs, "ok": st.OK, "errors": st.Errors,
			"blocked": st.Blocked, "block_rate": blockRate, "total_cost_krw": st.TotalCostKRW,
			"avg_latency_ms": st.AvgLatencyMS, "actors": st.Actors, "last_run_at": st.LastRunAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"window_since": since.UTC().Format(time.RFC3339), "stats": items})
}

// handleSkillRuns returns the skill execution log (optionally for one skill).
// GET /admin/skills/runs?skill=&limit=
func (s *Server) handleSkillRuns(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	runs, err := s.db.ListSkillRuns(r.Context(), strings.TrimSpace(r.URL.Query().Get("skill")), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_runs_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}
