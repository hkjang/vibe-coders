package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// promotionCriteria are the minimum performance bars a prompt version must clear
// to advance to the next lifecycle stage.
type promotionCriteria struct {
	toValidationMinCalls int64
	toValidationMaxError float64
	toValidationMaxEval  float64
	toProductionMinCalls int64
	toProductionMaxError float64
	toProductionMaxEval  float64
}

func defaultPromotionCriteria() promotionCriteria {
	return promotionCriteria{
		toValidationMinCalls: 20, toValidationMaxError: 0.10, toValidationMaxEval: 0.20,
		toProductionMinCalls: 50, toProductionMaxError: 0.05, toProductionMaxEval: 0.10,
	}
}

// eligibleNextStage returns the stage a version qualifies to advance to (one step),
// or "" if it does not currently qualify for promotion.
func eligibleNextStage(current string, stat store.PromptVersionStat, c promotionCriteria) string {
	switch current {
	case store.PromptStageProduction:
		return ""
	case store.PromptStageValidation:
		if stat.Calls >= c.toProductionMinCalls && stat.ErrorRate <= c.toProductionMaxError && stat.EvalFailRate <= c.toProductionMaxEval {
			return store.PromptStageProduction
		}
	default: // experiment (or unset)
		if stat.Calls >= c.toValidationMinCalls && stat.ErrorRate <= c.toValidationMaxError && stat.EvalFailRate <= c.toValidationMaxEval {
			return store.PromptStageValidation
		}
	}
	return ""
}

// handlePromptPromotions manages the prompt-version lifecycle (experiment →
// validation → production) and auto-promotes versions that meet the performance bar.
// GET /admin/prompts/promotions?window=7d
// POST {prompt_name, prompt_version, stage, note}  — manual stage set
// POST {action:"auto"}                              — auto-promote all eligible versions
func (s *Server) handlePromptPromotions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
		writeJSON(w, http.StatusOK, s.promotionView(w, r, since))
	case http.MethodPost:
		var p struct {
			Action        string `json:"action"`
			PromptName    string `json:"prompt_name"`
			PromptVersion string `json:"prompt_version"`
			Stage         string `json:"stage"`
			Note          string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.EqualFold(strings.TrimSpace(p.Action), "auto") {
			s.autoPromote(w, r)
			return
		}
		p.PromptName = strings.TrimSpace(p.PromptName)
		p.PromptVersion = strings.TrimSpace(p.PromptVersion)
		stage := strings.ToLower(strings.TrimSpace(p.Stage))
		if p.PromptName == "" || p.PromptVersion == "" {
			writeOpenAIError(w, http.StatusBadRequest, "prompt_name and prompt_version are required", "invalid_request_error", "missing_fields")
			return
		}
		if stage != store.PromptStageExperiment && stage != store.PromptStageValidation && stage != store.PromptStageProduction {
			writeOpenAIError(w, http.StatusBadRequest, "stage must be experiment/validation/production", "invalid_request_error", "invalid_stage")
			return
		}
		promo := store.PromptPromotion{PromptName: p.PromptName, PromptVersion: p.PromptVersion, Stage: stage, Note: strings.TrimSpace(p.Note), PromotedBy: adminID(r)}
		if err := s.db.SetPromptStage(r.Context(), promo); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "promotion_save_failed")
			return
		}
		s.auditAdmin(r, "prompt.promotion.set", "", auditJSON(promo))
		writeJSON(w, http.StatusOK, map[string]any{"promotion": promo})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// promotionView assembles current stages + stats + eligibility for every prompt version.
func (s *Server) promotionView(w http.ResponseWriter, r *http.Request, since time.Time) map[string]any {
	stats, _ := s.db.PromptVersionStatsSince(r.Context(), since)
	promos, _ := s.db.ListPromptPromotions(r.Context())
	stageByKey := map[string]string{}
	for _, p := range promos {
		stageByKey[p.PromptName+"\x00"+p.PromptVersion] = p.Stage
	}
	crit := defaultPromotionCriteria()
	rows := make([]map[string]any, 0, len(stats))
	for _, st := range stats {
		stage := stageByKey[st.PromptName+"\x00"+st.PromptVersion]
		if stage == "" {
			stage = store.PromptStageExperiment
		}
		rows = append(rows, map[string]any{
			"prompt_name":    st.PromptName,
			"prompt_version": st.PromptVersion,
			"stage":          stage,
			"stats":          st,
			"eligible_stage": eligibleNextStage(stage, st, crit),
		})
	}
	return map[string]any{
		"versions":   rows,
		"promotions": promos,
		"since":      since.UTC().Format(time.RFC3339),
		"stages":     []string{store.PromptStageExperiment, store.PromptStageValidation, store.PromptStageProduction},
	}
}

// autoPromote advances every eligible version one stage and reports what changed.
func (s *Server) autoPromote(w http.ResponseWriter, r *http.Request) {
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	stats, err := s.db.PromptVersionStatsSince(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "promotion_stats_failed")
		return
	}
	promos, _ := s.db.ListPromptPromotions(r.Context())
	stageByKey := map[string]string{}
	for _, p := range promos {
		stageByKey[p.PromptName+"\x00"+p.PromptVersion] = p.Stage
	}
	crit := defaultPromotionCriteria()
	promoted := []store.PromptPromotion{}
	for _, st := range stats {
		cur := stageByKey[st.PromptName+"\x00"+st.PromptVersion]
		if cur == "" {
			cur = store.PromptStageExperiment
		}
		next := eligibleNextStage(cur, st, crit)
		if next == "" {
			continue
		}
		promo := store.PromptPromotion{PromptName: st.PromptName, PromptVersion: st.PromptVersion, Stage: next, Note: "auto-promoted: meets " + next + " criteria", PromotedBy: "auto"}
		if err := s.db.SetPromptStage(r.Context(), promo); err == nil {
			promoted = append(promoted, promo)
		}
	}
	s.auditAdmin(r, "prompt.promotion.auto", "", auditJSON(map[string]any{"promoted": len(promoted)}))
	writeJSON(w, http.StatusOK, map[string]any{"promoted": promoted, "count": len(promoted)})
}
