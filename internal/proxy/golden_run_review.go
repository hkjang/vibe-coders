package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const goldenReviewedMaxCalls = 64
const goldenReviewedMaxOutputTokens = 4096
const goldenReviewedTimeout = 120 * time.Second

// Optional on the existing run APIs. Legacy callers retain their previous
// behavior. Reviewed callers execute the exact definitions loaded and checked
// here, even if a later edit changes the registry during model execution.
type goldenRunReview struct {
	Definitions     map[string]string `json:"definitions"`
	MaxCalls        int               `json:"max_calls"`
	MaxOutputTokens int               `json:"max_output_tokens"`
}

func goldenRunRevision(definition any) string {
	raw, err := json.Marshal(definition)
	if err != nil {
		return "" // Invalid stored definitions cannot pass a reviewed execution.
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func goldenPromptRevisions(rows []store.GoldenPrompt) map[string]string {
	revisions := make(map[string]string, len(rows))
	for _, row := range rows {
		revisions[row.ID] = goldenRunRevision(row)
	}
	return revisions
}

func goldenWorkflowRevisions(rows []store.GoldenWorkflow) map[string]string {
	revisions := make(map[string]string, len(rows))
	for _, row := range rows {
		revisions[row.ID] = goldenRunRevision(row)
	}
	return revisions
}

func checkGoldenRunReview(w http.ResponseWriter, review *goldenRunReview, revisions map[string]string, units, models int, minPassRate *float64) bool {
	if review == nil {
		return true
	}
	if review.MaxCalls < 1 || review.MaxCalls > goldenReviewedMaxCalls ||
		review.MaxOutputTokens < 1 || review.MaxOutputTokens > goldenReviewedMaxOutputTokens ||
		units < 1 || models < 1 || models > review.MaxCalls || units > review.MaxCalls/models ||
		(minPassRate != nil && (math.IsNaN(*minPassRate) || math.IsInf(*minPassRate, 0) || *minPassRate < 0 || *minPassRate > 1)) {
		writeOpenAIError(w, http.StatusBadRequest, "invalid reviewed execution limits or pass rate", "invalid_request_error", "golden_run_limits")
		return false
	}
	if len(review.Definitions) != len(revisions) {
		writeOpenAIError(w, http.StatusConflict, "reviewed definitions changed; review again", "invalid_request_error", "golden_run_changed")
		return false
	}
	for id, revision := range revisions {
		if len(revision) != 64 || review.Definitions[id] != revision {
			writeOpenAIError(w, http.StatusConflict, "reviewed definitions changed; review again", "invalid_request_error", "golden_run_changed")
			return false
		}
	}
	return true
}

func selectGoldenRunPrompts(w http.ResponseWriter, rows []store.GoldenPrompt, ids []string, tag string) ([]store.GoldenPrompt, bool) {
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || wanted[id] {
			writeOpenAIError(w, http.StatusBadRequest, "prompt ids must be nonempty and unique", "invalid_request_error", "golden_run_selection")
			return nil, false
		}
		wanted[id] = true
	}
	selected := make([]store.GoldenPrompt, 0, len(rows))
	for _, row := range rows {
		if (len(wanted) == 0 || wanted[row.ID]) && (tag == "" || containsString(row.Tags, tag)) {
			selected = append(selected, row)
		}
	}
	if len(wanted) > 0 && len(selected) != len(wanted) {
		writeOpenAIError(w, http.StatusConflict, "selected prompts changed; review again", "invalid_request_error", "golden_run_changed")
		return nil, false
	}
	return selected, true
}

func goldenRunContext(ctx context.Context, review *goldenRunReview) (context.Context, context.CancelFunc) {
	if review != nil {
		return context.WithTimeout(ctx, goldenReviewedTimeout)
	}
	return ctx, func() {}
}

func goldenOutputLimit(review *goldenRunReview) int {
	if review == nil {
		return 0
	}
	return review.MaxOutputTokens
}

func addGoldenRunCompletion(body map[string]any, planned, total int, ctx context.Context, review *goldenRunReview) {
	if review == nil {
		return
	}
	body["planned_total"] = planned
	body["complete"] = total == planned && ctx.Err() == nil
	body["max_output_tokens"] = review.MaxOutputTokens
	body["timeout_seconds"] = int(goldenReviewedTimeout.Seconds())
}
