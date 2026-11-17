package proxy

import (
	"context"
	"encoding/json"
	"net/http"

	"vibe-coders/internal/text2sql"
)

// Private request context, never an externally supplied header. A reviewed
// physical probe cannot enter an executor with unreviewed nested model/tool calls.
type redTeamReviewedOutputKey struct{}

func redTeamReviewedOutput(ctx context.Context) int {
	limit, _ := ctx.Value(redTeamReviewedOutputKey{}).(int)
	if limit < 1 || limit > redTeamReviewedMaxOutput {
		return 0
	}
	return limit
}
func (s *Server) redTeamVirtualModel(r *http.Request, model string) (bool, error) {
	if isAutoModelAlias(model) || text2sql.IsModel(model) || isMCPDiscoveryModel(canonicalMCPDiscoveryModel(model)) {
		return true, nil
	}
	route, found, err := s.db.GetAgentRouteByModel(r.Context(), model)
	return found && route.Enabled, err
}
func (rc *requestPipeline) rejectReviewedVirtualModel() bool {
	if redTeamReviewedOutput(rc.r.Context()) == 0 {
		return false
	}
	writeOpenAIError(rc.w, http.StatusBadRequest, "multi-stage virtual models require a separate execution review", "invalid_request_error", "redteam_review_virtual_model")
	return true
}

// Reapply the bound immediately before the physical upstream dial, after normal
// routing and governance. A future body rewrite must not silently raise it.
func (rc *requestPipeline) reviewedPhysicalBody(body []byte) ([]byte, bool) {
	limit := redTeamReviewedOutput(rc.r.Context())
	if limit == 0 {
		return body, true
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil || payload == nil {
		writeOpenAIError(rc.w, http.StatusBadRequest, "reviewed request body unavailable", "invalid_request_error", "redteam_review_body_invalid")
		return nil, false
	}
	if _, ok := payload["max_completion_tokens"]; ok {
		payload["max_completion_tokens"] = limit
		delete(payload, "max_tokens")
	} else {
		payload["max_tokens"] = limit
	}
	payload["n"], payload["stream"] = 1, false
	encoded, err := json.Marshal(payload)
	return encoded, err == nil
}
