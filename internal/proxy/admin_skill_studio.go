package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// skillCandidate is a proposed skill mined from existing signals (recurring prompt
// fingerprints, productized prompts, recurring Text2SQL questions, and cross-user
// personalization recommendations). The operator reviews candidates in Skill Studio,
// adopts one as a draft skill, then drives it through the evaluate → chat-test →
// staging → production wizard.
type skillCandidate struct {
	ID            string         `json:"id"`     // stable slug used as the suggested skill name
	Source        string         `json:"source"` // fingerprint | product | text2sql | recommendation | skill_gap
	SuggestedName string         `json:"suggested_name"`
	Title         string         `json:"title"`
	Description   string         `json:"description"`
	Sample        string         `json:"sample"`
	Rationale     string         `json:"rationale"`
	Signal        map[string]any `json:"signal"`
	Suggested     skillDefaults  `json:"suggested"`
	AlreadySkill  bool           `json:"already_skill"` // a skill with this name already exists
	Score         float64        `json:"score"`         // ranking weight (higher = stronger candidate)
}

// skillDefaults are the seed values pre-filled into the adopt form / draft skill.
type skillDefaults struct {
	RiskLevel     string `json:"risk_level"`
	AllowedModels string `json:"allowed_models"`
	AllowedTools  string `json:"allowed_tools"`
	Instructions  string `json:"instructions"`
}

// handleSkillStudioCandidates mines skill candidates from existing data and returns them
// ranked, marking which already have a backing skill.
// GET /admin/skill-studio/candidates?window=&min_count=&limit=
func (s *Server) handleSkillStudioCandidates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := intQuery(r, "min_count", 3)
	limit := intQuery(r, "limit", 40)
	if limit <= 0 || limit > 200 {
		limit = 40
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

	cands := []skillCandidate{}

	// Source 1: recurring chat prompt fingerprints — repeated task shapes worth standardizing.
	if fps, err := s.db.PromptFingerprints(r.Context(), since, 60); err == nil {
		for _, fp := range fps {
			if fp.Requests < int64(minCount) {
				continue
			}
			slug := studioSlug(fp.TaskType + "-" + fp.Fingerprint[:min(8, len(fp.Fingerprint))])
			name := "skill-" + slug
			instr := "반복되는 '" + fp.TaskType + "' 유형 작업을 표준화하는 스킬입니다."
			if strings.TrimSpace(fp.SamplePrompt) != "" {
				instr += "\n대표 요청 예시:\n" + fp.SamplePrompt
			}
			cands = append(cands, skillCandidate{
				ID: name, Source: "fingerprint", SuggestedName: name,
				Title:       fp.TaskType + " 표준화 (" + itoa64(fp.Requests) + "회 반복)",
				Description: "프롬프트 클러스터 " + fp.Fingerprint[:min(12, len(fp.Fingerprint))],
				Sample:      fp.SamplePrompt,
				Rationale:   itoa64(fp.Requests) + "회 반복 · 모델 " + itoa64(fp.DistinctModels) + "종 · 성공률 " + pct(fp.SuccessRate),
				Signal: map[string]any{
					"requests": fp.Requests, "avg_cost_krw": fp.AvgCostKRW, "total_cost_krw": fp.TotalCostKRW,
					"success_rate": fp.SuccessRate, "top_model": fp.TopModel, "cheapest_model": fp.CheapestModel,
				},
				Suggested: skillDefaults{
					RiskLevel: "low", AllowedModels: studioModelHint(fp.CheapestModel, fp.TopModel), Instructions: instr,
				},
				AlreadySkill: have[name],
				Score:        float64(fp.Requests) * (0.5 + fp.SuccessRate),
			})
		}
	}

	// Source 2: productized prompts — already-curated reusable prompts, natural skill seeds.
	if products, err := s.db.ListPromptProducts(r.Context()); err == nil {
		for _, p := range products {
			name := "skill-" + studioSlug(p.Name)
			cands = append(cands, skillCandidate{
				ID: name, Source: "product", SuggestedName: name,
				Title:       p.Name,
				Description: p.Description,
				Rationale:   "프롬프트 상품 (요청 " + itoa64(p.RequestCount) + " · 사용자 " + itoa64(p.DistinctUsers) + " · 재사용 " + itoa64(p.TemplateUseCount) + ")",
				Signal: map[string]any{
					"request_count": p.RequestCount, "distinct_users": p.DistinctUsers,
					"template_use_count": p.TemplateUseCount, "category": p.Category,
				},
				Suggested:    skillDefaults{RiskLevel: "low", Instructions: "프롬프트 상품 '" + p.Name + "'을 스킬로 표준화합니다.\n" + p.Description},
				AlreadySkill: have[name],
				Score:        float64(p.RequestCount+p.DistinctUsers*3+p.TemplateUseCount) + 20,
			})
		}
	}

	// Source 3: recurring Text2SQL questions — the report-candidate signal.
	if t2s, err := s.db.Text2SQLReportCandidates(r.Context(), since, minCount, 30); err == nil {
		for _, c := range t2s {
			q := strings.TrimSpace(c.Question)
			if q == "" {
				continue
			}
			name := "answer-" + studioSlug(q)
			instr := "반복되는 질문 '" + q + "'에 답하는 표준 절차입니다."
			if strings.TrimSpace(c.SampleSQL) != "" {
				instr += "\n검증된 SQL 패턴:\n" + c.SampleSQL
			}
			cands = append(cands, skillCandidate{
				ID: name, Source: "text2sql", SuggestedName: name,
				Title:        q,
				Description:  "반복 Text2SQL 질문 (" + itoa64(c.Count) + "회)",
				Sample:       c.SampleSQL,
				Rationale:    itoa64(c.Count) + "회 질의 · 추천 상품 " + c.RecommendedProduct,
				Signal:       map[string]any{"count": c.Count, "recommended_product": c.RecommendedProduct},
				Suggested:    skillDefaults{RiskLevel: "medium", AllowedTools: "sql-runner", Instructions: instr},
				AlreadySkill: have[name],
				Score:        float64(c.Count) + 10,
			})
		}
	}

	// Source 4: cross-user personalization recommendations — what the org is repeatedly nudged toward.
	if recs, err := s.db.AggregateRecommendations(r.Context()); err == nil {
		for _, a := range recs {
			if a.Users < 2 { // only org-wide signals, not one-off
				continue
			}
			label := a.Title
			if strings.TrimSpace(label) == "" {
				label = a.Kind + " " + a.Ref
			}
			name := "skill-" + studioSlug(a.Kind+"-"+label)
			def := skillDefaults{RiskLevel: "low", Instructions: a.Title}
			if strings.TrimSpace(a.Detail) != "" {
				def.Instructions = a.Title + "\n" + a.Detail
			}
			if a.Kind == "template" && strings.TrimSpace(a.Ref) != "" {
				def.Instructions += "\n참조 템플릿: " + a.Ref
			}
			cands = append(cands, skillCandidate{
				ID: name, Source: "recommendation", SuggestedName: name,
				Title:        label,
				Description:  a.Kind + " 추천이 " + itoa64(a.Users) + "명에게 제안됨",
				Rationale:    "사용자 " + itoa64(a.Users) + "명 · 누적 " + itoa64(a.Count) + "회 · 예상 절감 ₩" + ftoa(a.TotalSavingsKRW),
				Signal:       map[string]any{"users": a.Users, "count": a.Count, "kind": a.Kind, "ref": a.Ref, "savings_krw": a.TotalSavingsKRW},
				Suggested:    def,
				AlreadySkill: have[name],
				Score:        float64(a.Users)*5 + float64(a.Count),
			})
		}
	}

	// Rank: strongest signal first, then de-prioritize already-adopted candidates.
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].AlreadySkill != cands[j].AlreadySkill {
			return !cands[i].AlreadySkill
		}
		return cands[i].Score > cands[j].Score
	})
	if len(cands) > limit {
		cands = cands[:limit]
	}

	bySource := map[string]int{}
	for _, c := range cands {
		bySource[c.Source]++
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates":   cands,
		"count":        len(cands),
		"by_source":    bySource,
		"window_since": since.UTC().Format(time.RFC3339),
	})
}

// handleSkillStudioAdopt promotes a candidate into a draft skill (always draft — the
// wizard then drives it through the gated lifecycle). Idempotent by name.
// POST /admin/skill-studio/adopt {name, description, instructions, risk_level,
//
//	allowed_models, allowed_tools, allowed_teams, daily_limit,
//	source, signal}
func (s *Server) handleSkillStudioAdopt(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Name          string          `json:"name"`
		Description   string          `json:"description"`
		Instructions  string          `json:"instructions"`
		RiskLevel     string          `json:"risk_level"`
		AllowedModels string          `json:"allowed_models"`
		AllowedTools  string          `json:"allowed_tools"`
		AllowedTeams  string          `json:"allowed_teams"`
		DailyLimit    int             `json:"daily_limit"`
		Source        string          `json:"source"`
		Signal        json.RawMessage `json:"signal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	name := studioSlug(p.Name)
	if name == "" {
		writeOpenAIError(w, http.StatusBadRequest, "a valid name is required", "invalid_request_error", "missing_name")
		return
	}
	if _, found, _ := s.db.GetSkill(r.Context(), name); found {
		writeOpenAIError(w, http.StatusConflict, "skill '"+name+"' already exists", "invalid_request_error", "already_exists")
		return
	}
	risk := strings.TrimSpace(p.RiskLevel)
	if !validSkillRisk[risk] {
		risk = "low"
	}
	signal := strings.TrimSpace(string(p.Signal))
	if signal == "" || signal == "null" || !json.Valid([]byte(signal)) {
		signal = "{}"
	}
	meta := auditJSON(map[string]any{
		"origin":     "skill_studio",
		"source":     strings.TrimSpace(p.Source),
		"signal":     json.RawMessage(signal),
		"adopted_at": time.Now().UTC().Format(time.RFC3339),
	})
	saved, err := s.db.UpsertSkill(r.Context(), store.Skill{
		Name: name, Description: strings.TrimSpace(p.Description), Status: "draft", RiskLevel: risk,
		AllowedModels: strings.TrimSpace(p.AllowedModels), AllowedTools: strings.TrimSpace(p.AllowedTools),
		AllowedTeams: strings.TrimSpace(p.AllowedTeams), DailyLimit: p.DailyLimit,
		Instructions: p.Instructions, Metadata: meta,
	}, s.skillActor(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skill_adopt_failed")
		return
	}
	s.auditAdmin(r, "skill.studio_adopt", saved.Name, auditJSON(map[string]any{"source": p.Source}))
	writeJSON(w, http.StatusCreated, map[string]any{"skill": saved})
}

// handleSkillStudioReadiness returns the production-readiness checklist for the wizard: the
// transition gate, mandatory policy guardrails, and the security scan. The wizard renders
// this as a checklist and only enables "프로덕션 승격" when everything required passes.
// GET /admin/skill-studio/readiness?name=
func (s *Server) handleSkillStudioReadiness(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
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
	checks := productionPolicyChecks(sk)
	scan := scanSkillSecurity(sk)
	scanOK := scan.HighCount == 0
	checks = append(checks, policyCheck{
		Key: "security_scan", Label: "보안 스캔(high 0건)", Required: true, OK: scanOK,
		Detail: "high 심각도 발견 시 프로덕션 차단",
	})
	// Model-fitness gate (v0.52.3): high-risk (or opt-in) skills need ≥N passing fitness
	// evidence records. Surface it here so the wizard reflects the real promotion gate.
	fitnessPassing := 0
	if modelFitnessRequired(sk) {
		fitnessPassing, _ = s.db.CountPassingSkillFitnessEvidence(r.Context(), name)
		checks = append(checks, policyCheck{
			Key: "model_fitness", Label: "모델 적합성 근거(" + itoaProxy(skillFitnessMinEvidence) + "건+)", Required: true,
			OK:     fitnessPassing >= skillFitnessMinEvidence,
			Detail: "high 위험도(또는 require_model_fitness) 스킬은 멀티모델/Golden/테스트케이스 통과 근거 " + itoaProxy(skillFitnessMinEvidence) + "건 이상 필요 (현재 " + itoaProxy(fitnessPassing) + "건)",
		})
	}

	allReady := true
	for _, c := range checks {
		if c.Required && !c.OK {
			allReady = false
		}
	}
	// The next legal transition in the lifecycle (for the wizard's primary action).
	nextStatus := ""
	switch sk.Status {
	case "draft":
		nextStatus = "staging"
	case "staging":
		nextStatus = "production"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":              sk.Name,
		"status":            sk.Status,
		"next_status":       nextStatus,
		"checks":            checks,
		"production_ready":  allReady,
		"scan":              scan,
		"fitness_required":  modelFitnessRequired(sk),
		"fitness_passing":   fitnessPassing,
		"fitness_threshold": skillFitnessMinEvidence,
	})
}

// ── helpers ────────────────────────────────────────────────────────────────

// studioSlug normalizes a label into a stable, lowercase, hyphenated skill-name slug.
func studioSlug(s string) string {
	slug := okfSlug(s)
	if len(slug) > 48 {
		slug = strings.Trim(slug[:48], "-")
	}
	return slug
}

// studioModelHint suggests an allowed_models seed from a cluster's cost-optimal/top model.
func studioModelHint(cheapest, top string) string {
	if strings.TrimSpace(cheapest) != "" && cheapest != "(unknown)" {
		return cheapest
	}
	if strings.TrimSpace(top) != "" && top != "(unknown)" {
		return top
	}
	return ""
}

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

func ftoa(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }

func pct(v float64) string { return ftoa(v*100) + "%" }
