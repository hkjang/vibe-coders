package proxy

import (
	"net/http"
	"net/url"
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
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	traceID, valid := adminTracePathID(r.URL.Path, "/admin/traces/", "")
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "invalid trace id", "invalid_request_error", "invalid_trace_id")
		return
	}
	ctx := r.Context()
	teams, teamScoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	requests, err := s.db.RecentRequests(ctx, store.RequestFilter{
		TraceID: traceID, Limit: 200, Teams: teams, TeamScoped: teamScoped,
	})
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	workflowRuns, err := s.db.WorkflowRunsByTrace(ctx, traceID)
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	appRuns, err := s.db.AIAppRunsByTrace(ctx, traceID)
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	codeVerdicts, err := s.db.CodeVerifyByTrace(ctx, traceID)
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	if teamScoped {
		workflowRuns = traceWorkflowRunsForTeams(workflowRuns, teams)
		appRuns = traceAppRunsForTeams(appRuns, teams)
		codeVerdicts = traceCodeVerdictsForRequests(codeVerdicts, requests)
	}

	// Lightweight request rows (the per-request waterfall lives at /admin/requests/{id}/trace).
	reqRows := make([]map[string]any, 0, len(requests))
	for _, rq := range requests {
		reqRows = append(reqRows, map[string]any{
			"request_id": rq.ID, "model": rq.Model, "provider": rq.Provider, "status_code": rq.StatusCode,
			"latency_ms": rq.LatencyMS, "total_tokens": rq.TotalTokens, "cost_krw": rq.EstimatedCost,
			"endpoint": rq.Endpoint, "created_at": rq.CreatedAt,
			"trace": "/admin/requests/" + url.PathEscape(rq.ID) + "/trace",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"trace_id":      traceID,
		"requests":      reqRows,
		"workflow_runs": workflowRuns,
		"app_runs":      appRuns,
		"code_verdicts": codeVerdicts,
		"counts":        map[string]int{"requests": len(reqRows), "workflow_runs": len(workflowRuns), "app_runs": len(appRuns), "code_verdicts": len(codeVerdicts)},
		"note":          "이 trace_id로 묶인 게이트웨이 요청·워크플로·앱 실행입니다. 요청별 단계 waterfall은 request trace 링크로 확인하세요.",
	})
}

func writeTraceQueryFailed(w http.ResponseWriter) {
	writeOpenAIError(w, http.StatusInternalServerError, "trace query failed", "server_error", "trace_query_failed")
}

func traceAllowedTeams(teams []string) map[string]struct{} {
	allowed := make(map[string]struct{}, len(teams))
	for _, team := range teams {
		// Authorization identities are exact values. Reject malformed padded values
		// instead of normalizing them into an existing team's identity.
		if team != "" && strings.TrimSpace(team) == team {
			allowed[team] = struct{}{}
		}
	}
	return allowed
}

func traceWorkflowRunsForTeams(rows []store.WorkflowRun, teams []string) []store.WorkflowRun {
	allowed := traceAllowedTeams(teams)
	filtered := make([]store.WorkflowRun, 0, len(rows))
	for _, row := range rows {
		if _, ok := allowed[row.Team]; ok {
			filtered = append(filtered, row)
		}
	}
	return filtered
}

func traceAppRunsForTeams(rows []store.AIAppRun, teams []string) []store.AIAppRun {
	allowed := traceAllowedTeams(teams)
	filtered := make([]store.AIAppRun, 0, len(rows))
	for _, row := range rows {
		if _, ok := allowed[row.Team]; ok {
			filtered = append(filtered, row)
		}
	}
	return filtered
}

func traceCodeVerdictsForRequests(rows []store.CodeVerifyLog, requests []store.RecentRequest) []store.CodeVerifyLog {
	allowed := make(map[string]struct{}, len(requests))
	for _, request := range requests {
		allowed[request.ID] = struct{}{}
	}
	filtered := make([]store.CodeVerifyLog, 0, len(rows))
	for _, row := range rows {
		if _, ok := allowed[row.RequestID]; ok {
			filtered = append(filtered, row)
		}
	}
	return filtered
}
