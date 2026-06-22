package proxy

import (
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// handleTraceByID returns everything sharing a trace_id: the gateway request(s), plus any
// workflow runs and AI app runs stamped with that trace. This connects a user's single action
// across /v1 requests, workflows, and apps — the trace-wide companion to the per-request waterfall.
// GET /admin/traces/{trace_id}
func (s *Server) handleTraceByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	traceID := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/admin/traces/"))
	if traceID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "trace_id required", "invalid_request_error", "bad_request")
		return
	}
	ctx := r.Context()
	requests, _ := s.db.RecentRequests(ctx, store.RequestFilter{TraceID: traceID, Limit: 200})
	workflowRuns, _ := s.db.WorkflowRunsByTrace(ctx, traceID)
	appRuns, _ := s.db.AIAppRunsByTrace(ctx, traceID)

	// Lightweight request rows (the per-request waterfall lives at /admin/requests/{id}/trace).
	reqRows := make([]map[string]any, 0, len(requests))
	for _, rq := range requests {
		reqRows = append(reqRows, map[string]any{
			"request_id": rq.ID, "model": rq.Model, "provider": rq.Provider, "status_code": rq.StatusCode,
			"latency_ms": rq.LatencyMS, "total_tokens": rq.TotalTokens, "cost_krw": rq.EstimatedCost,
			"endpoint": rq.Endpoint, "created_at": rq.CreatedAt,
			"trace": "/admin/requests/" + rq.ID + "/trace",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"trace_id":      traceID,
		"requests":      reqRows,
		"workflow_runs": workflowRuns,
		"app_runs":      appRuns,
		"counts":        map[string]int{"requests": len(reqRows), "workflow_runs": len(workflowRuns), "app_runs": len(appRuns)},
		"note":          "이 trace_id로 묶인 게이트웨이 요청·워크플로·앱 실행입니다. 요청별 단계 waterfall은 request trace 링크로 확인하세요.",
	})
}
