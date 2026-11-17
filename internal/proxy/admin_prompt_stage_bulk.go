package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

const promptStageReviewLifetime = 5 * time.Minute

func promptStageDuration(window string) (time.Duration, bool) {
	duration, ok := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[window]
	return duration, ok
}

type promptStageCriterion struct {
	Stage                            string  `json:"stage"`
	MinimumCalls                     int64   `json:"minimum_calls"`
	MaximumErrorRate                 float64 `json:"maximum_error_rate"`
	MaximumEvaluationFailuresPerCall float64 `json:"maximum_evaluation_failures_per_call"`
}

func promptStageCriteriaView() []promptStageCriterion {
	c := defaultPromotionCriteria()
	return []promptStageCriterion{
		{"validation", c.toValidationMinCalls, c.toValidationMaxError, c.toValidationMaxEval},
		{"production", c.toProductionMinCalls, c.toProductionMaxError, c.toProductionMaxEval},
	}
}

type promptStageBulkReview struct {
	Window        string                     `json:"window"`
	Since         time.Time                  `json:"since"`
	Until         time.Time                  `json:"until"`
	ExpiresAt     time.Time                  `json:"expires_at"`
	Revision      string                     `json:"revision"`
	Items         []promptStageWorkspaceItem `json:"items"`
	ObservedCount int                        `json:"observed_count"`
	IgnoredCount  int                        `json:"ignored_count"`
	BlockedCount  int                        `json:"blocked_count"`
	Criteria      []promptStageCriterion     `json:"criteria"`
}

func (s *Server) promptStageBulkReview(cipher *secret.Cipher, actor, window string, since, until time.Time, rows []store.PromptStageWorkspaceRow) (promptStageBulkReview, []store.PromptStageBatchChange) {
	review := promptStageBulkReview{Window: window, Since: since, Until: until, ExpiresAt: until.Add(promptStageReviewLifetime), Items: []promptStageWorkspaceItem{}, ObservedCount: len(rows), Criteria: promptStageCriteriaView()}
	plan := []store.PromptStageBatchChange{}
	for _, row := range rows {
		item := s.projectPromptStage(cipher, row)
		if item.EligibleStage == "" {
			review.IgnoredCount++
			continue
		}
		review.Items = append(review.Items, item)
		if !item.CanChange {
			review.BlockedCount++
			continue
		}
		plan = append(plan, store.PromptStageBatchChange{Expected: row.Snapshot, Stage: item.EligibleStage})
	}
	if len(plan) > 0 && review.BlockedCount == 0 {
		material, _ := json.Marshal(struct {
			Actor, Window string
			Since, Until  time.Time
			Rows          []store.PromptStageWorkspaceRow
			Criteria      []promptStageCriterion
		}{actor, window, since, until, rows, review.Criteria})
		review.Revision = cipher.OpaqueReference("prompt-stage-bulk-review/v1", string(material))
	}
	return review, plan
}

func (s *Server) handlePromptStageBulk(w http.ResponseWriter, r *http.Request, query url.Values) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	window := "7d"
	for key, values := range query {
		if len(values) != 1 || (key != "view" && (key != "window" || r.Method != http.MethodGet)) {
			writePromptStageInvalid(w)
			return
		}
		if key == "window" {
			window = values[0]
		}
	}
	if query.Get("view") != "promotion-review" {
		writePromptStageInvalid(w)
		return
	}
	switch r.Method {
	case http.MethodGet:
		duration, ok := promptStageDuration(window)
		if !ok {
			writePromptStageInvalid(w)
			return
		}
		until := time.Now().UTC()
		since := until.Add(-duration)
		rows, err := s.db.PromptStageBulkSnapshot(r.Context(), since, until)
		if err != nil {
			writePromptStageBulkError(w, err)
			return
		}
		review, _ := s.promptStageBulkReview(s.secrets.Load(), adminID(r), window, since, until, rows)
		writeJSON(w, 200, review)
	case http.MethodPost:
		s.applyPromptStageBulk(w, r)
	default:
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func writePromptStageBulkError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrPromptStageConflict) {
		writePromptStageConflict(w)
	} else if errors.Is(err, store.ErrPromptStageBulkLimit) {
		writeOpenAIError(w, 400, "observation interval has too many prompt versions; narrow the interval", "invalid_request_error", "prompt_stage_bulk_limit")
	} else {
		writePromptStageFailure(w)
	}
}

func (s *Server) applyPromptStageBulk(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Window   string    `json:"window"`
		Since    time.Time `json:"since"`
		Until    time.Time `json:"until"`
		Revision string    `json:"revision"`
		Reason   string    `json:"reason"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil {
		writePromptStageInvalid(w)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		writePromptStageInvalid(w)
		return
	}
	payload.Reason = strings.TrimSpace(payload.Reason)
	duration, ok := promptStageDuration(payload.Window)
	if !ok || payload.Until.Sub(payload.Since) != duration || len(payload.Revision) != 43 || payload.Reason == "" || utf8.RuneCountInString(payload.Reason) > 500 || !s.safeResourceSearchText(payload.Reason) {
		writePromptStageInvalid(w)
		return
	}
	now := time.Now().UTC()
	if payload.Until.After(now) || !payload.Until.Add(promptStageReviewLifetime).After(now) {
		writePromptStageConflict(w)
		return
	}
	cipher := s.secrets.Load()
	actor := adminID(r)
	var audit store.AdminAuditLog
	changed, err := s.db.ApplyPromptStageBulk(r.Context(), payload.Since, payload.Until, payload.Reason, func(rows []store.PromptStageWorkspaceRow) ([]store.PromptStageBatchChange, store.AdminAuditLog, error) {
		if !payload.Until.Add(promptStageReviewLifetime).After(time.Now().UTC()) {
			return nil, audit, store.ErrPromptStageConflict
		}
		review, plan := s.promptStageBulkReview(cipher, actor, payload.Window, payload.Since, payload.Until, rows)
		if review.Revision == "" || subtle.ConstantTimeCompare([]byte(review.Revision), []byte(payload.Revision)) != 1 {
			return nil, audit, store.ErrPromptStageConflict
		}
		before, after := []map[string]any{}, []map[string]any{}
		for _, item := range review.Items {
			before = append(before, map[string]any{"reference": item.Reference, "stage": item.Stage, "registered": item.Registered})
			after = append(after, map[string]any{"reference": item.Reference, "stage": item.EligibleStage})
		}
		audit = store.AdminAuditLog{ID: newID("audit"), AdminID: actor, Action: "prompt.promotion.auto", BeforeValue: auditJSON(map[string]any{"since": payload.Since, "until": payload.Until, "versions": before}), AfterValue: auditJSON(map[string]any{"versions": after, "count": len(plan), "reason": payload.Reason})}
		return plan, audit, nil
	})
	if err != nil {
		writePromptStageBulkError(w, err)
		return
	}
	s.runAdminPostChange(r, audit.Action, audit.BeforeValue, audit.AfterValue, "")
	writeJSON(w, 200, map[string]any{"count": len(changed), "updated_at": changed[0].UpdatedAt, "review_revision": payload.Revision})
}
