package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// skillFitnessMinEvidence is how many passing fitness-evidence records a gated skill needs to
// reach production.
const skillFitnessMinEvidence = 2

// modelFitnessRequired reports whether the model-fitness gate applies to this skill: always for
// high-risk skills, and opt-in for others via metadata {"require_model_fitness": true}.
func modelFitnessRequired(sk store.Skill) bool {
	if strings.EqualFold(sk.RiskLevel, "high") {
		return true
	}
	if strings.TrimSpace(sk.Metadata) == "" {
		return false
	}
	var meta map[string]any
	if err := json.Unmarshal([]byte(sk.Metadata), &meta); err != nil {
		return false
	}
	switch v := meta["require_model_fitness"].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	}
	return false
}

// modelFitnessGate returns a non-empty reason when a production transition is blocked by the
// model-fitness gate. ok=true means the gate is satisfied (or not applicable).
func modelFitnessGate(sk store.Skill, toStatus string, passingEvidence int) string {
	if toStatus != "production" || !modelFitnessRequired(sk) {
		return ""
	}
	if passingEvidence < skillFitnessMinEvidence {
		return "model-fitness gate: 프로덕션 전환 전 최소 " + itoaProxy(skillFitnessMinEvidence) +
			"건의 통과한 모델 적합성 근거(멀티모델 테스트/Golden/테스트케이스)가 필요합니다 (현재 " + itoaProxy(passingEvidence) + "건)"
	}
	return ""
}

// handleSkillFitness records (POST) or lists (GET ?skill=) model-fitness evidence for a skill.
// POST /admin/skills/fitness {skill, kind, ref_id, passed, score, note}
func (s *Server) handleSkillFitness(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		skill := strings.TrimSpace(r.URL.Query().Get("skill"))
		if skill == "" {
			writeOpenAIError(w, http.StatusBadRequest, "skill query param is required", "invalid_request_error", "missing_skill")
			return
		}
		ev, err := s.db.ListSkillFitnessEvidence(r.Context(), skill)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		passing := 0
		for _, e := range ev {
			if e.Passed {
				passing++
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"skill": skill, "evidence": ev, "passing_count": passing, "required": skillFitnessMinEvidence,
		})
	case http.MethodPost:
		var p struct {
			Skill  string  `json:"skill"`
			Kind   string  `json:"kind"`
			RefID  string  `json:"ref_id"`
			Passed bool    `json:"passed"`
			Score  float64 `json:"score"`
			Note   string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Skill) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "skill is required", "invalid_request_error", "bad_request")
			return
		}
		kind := strings.TrimSpace(p.Kind)
		if kind != "multimodel" && kind != "golden" && kind != "testcase" {
			kind = "multimodel"
		}
		ev := store.SkillFitnessEvidence{
			ID: newID("skfit"), SkillName: strings.TrimSpace(p.Skill), Kind: kind,
			RefID: strings.TrimSpace(p.RefID), Passed: p.Passed, Score: p.Score, Note: strings.TrimSpace(p.Note),
			CreatedBy: s.skillActor(r),
		}
		if err := s.db.AddSkillFitnessEvidence(r.Context(), ev); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "add_failed")
			return
		}
		s.auditAdmin(r, "skill.fitness_evidence", ev.SkillName, auditJSON(map[string]any{"kind": kind, "passed": p.Passed, "ref": ev.RefID}))
		writeJSON(w, http.StatusCreated, ev)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
