package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

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
			Instructions: p.Instructions, Metadata: meta,
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
	violations := evaluateSkillPolicy(sk, strings.TrimSpace(p.Model), p.Tools)
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
