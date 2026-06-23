package proxy

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// Agent Session Flight Recorder (로드맵 2차).
//
// 한 코딩 세션(session_id) 안에서 일어난 모든 게이트웨이 활동을 시간순 타임라인으로 재구성한다.
// 각 요청을 이벤트로 펼치고(chat/embedding/text2sql/기타), 세션 단위 롤업(모델·provider·trace·
// 토큰·비용·오류·도구호출)을 함께 제공해 "이 세션에서 무슨 일이 어떤 순서로 일어났는지"를
// 장애·비용·보안 RCA에서 빠르게 파악하게 한다. 원문은 노출하지 않고 안전 메타만 사용한다.

// endpointKind maps a request endpoint to a coarse activity category for the timeline.
func endpointKind(endpoint string) string {
	e := strings.ToLower(endpoint)
	switch {
	case strings.Contains(e, "chat/completions"):
		return "chat"
	case strings.Contains(e, "embeddings"):
		return "embedding"
	case strings.Contains(e, "responses"):
		return "responses"
	case strings.Contains(e, "messages"):
		return "messages"
	case strings.Contains(e, "completions"):
		return "completion"
	default:
		return strings.TrimPrefix(endpoint, "/v1/")
	}
}

// handleSessionList returns recent coding sessions (rolled up) for the flight-recorder index.
// GET /admin/sessions?days=
func (s *Server) handleSessionList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	days := 7
	if d := strings.TrimSpace(r.URL.Query().Get("days")); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	sessions, err := s.db.RecentSessions(r.Context(), since, 200)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "session_list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days":     days,
		"sessions": sessions,
		"note":     "최근 코딩 세션(클라이언트 session_id)을 활동순으로 보여줍니다. 각 세션의 비행기록으로 드릴인하세요.",
	})
}

// handleSessionFlightRecorder assembles the chronological flight recorder for a session.
// GET /admin/sessions/{session_id}/flight-recorder
func (s *Server) handleSessionFlightRecorder(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/sessions/")
	sessionID := rest
	if i := strings.Index(rest, "/"); i >= 0 {
		sessionID = rest[:i]
		if rest[i+1:] != "flight-recorder" {
			writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
			return
		}
	} else {
		// Bare /admin/sessions/{id} is not a defined endpoint.
		writeOpenAIError(w, http.StatusNotFound, "use /flight-recorder", "invalid_request_error", "not_found")
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "session_id required", "invalid_request_error", "bad_request")
		return
	}

	reqs, err := s.db.RecentRequests(r.Context(), store.RequestFilter{SessionID: sessionID, Limit: 500})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "flight_recorder_failed")
		return
	}
	// RecentRequests is newest-first; replay chronologically.
	sort.SliceStable(reqs, func(i, j int) bool { return reqs[i].CreatedAt < reqs[j].CreatedAt })

	// Governance/risk markers tied to this session's requests (best-effort overlay).
	markers, _ := s.db.SessionRiskMarkersFor(r.Context(), sessionID)

	events := make([]map[string]any, 0, len(reqs))
	models := map[string]bool{}
	providers := map[string]bool{}
	traces := map[string]bool{}
	kinds := map[string]int{}
	var totalTokens int
	var totalCost float64
	var errorCount, toolCalls int
	var secretReqs, policyBlockReqs, highRiskCodeReqs int
	startedAt, endedAt := "", ""

	for _, rq := range reqs {
		kind := endpointKind(rq.Endpoint)
		kinds[kind]++
		if rq.Model != "" {
			models[rq.Model] = true
		}
		if rq.Provider != "" {
			providers[rq.Provider] = true
		}
		if rq.TraceID != "" {
			traces[rq.TraceID] = true
		}
		totalTokens += rq.TotalTokens
		totalCost += rq.EstimatedCost
		toolCalls += rq.ToolCount
		isError := rq.StatusCode >= 400 || rq.Error != ""
		if isError {
			errorCount++
		}
		if startedAt == "" {
			startedAt = rq.CreatedAt
		}
		endedAt = rq.CreatedAt
		ev := map[string]any{
			"request_id":   rq.ID,
			"trace_id":     rq.TraceID,
			"kind":         kind,
			"endpoint":     rq.Endpoint,
			"model":        rq.Model,
			"provider":     rq.Provider,
			"status_code":  rq.StatusCode,
			"is_error":     isError,
			"latency_ms":   rq.LatencyMS,
			"total_tokens": rq.TotalTokens,
			"cost_krw":     rq.EstimatedCost,
			"tool_count":   rq.ToolCount,
			"created_at":   rq.CreatedAt,
			"detail":       "/admin/requests/" + rq.ID,
			"trace":        "/admin/requests/" + rq.ID + "/trace",
		}
		// Governance/risk overlay for this request.
		if n := markers.Secrets[rq.ID]; n > 0 {
			ev["secret_events"] = n
			secretReqs++
		}
		if n := markers.PolicyBlocks[rq.ID]; n > 0 {
			ev["policy_blocks"] = n
			policyBlockReqs++
		}
		if risk := markers.CodeRisk[rq.ID]; risk != "" {
			ev["code_risk"] = risk
			if risk == "high" {
				highRiskCodeReqs++
			}
		}
		events = append(events, ev)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID,
		"events":     events,
		"rollup": map[string]any{
			"requests":     len(events),
			"started_at":   startedAt,
			"ended_at":     endedAt,
			"models":       keysOf(models),
			"providers":    keysOf(providers),
			"trace_ids":    keysOf(traces),
			"kinds":        kinds,
			"total_tokens": totalTokens,
			"total_cost":   totalCost,
			"errors":       errorCount,
			"tool_calls":   toolCalls,
			"risk": map[string]int{
				"secret_requests":         secretReqs,
				"policy_block_requests":   policyBlockReqs,
				"high_risk_code_requests": highRiskCodeReqs,
			},
		},
		"note": "한 세션(session_id)의 게이트웨이 요청을 시간순으로 재구성한 비행기록입니다. 각 이벤트는 요청 상세·trace로 연결됩니다. 원문은 포함되지 않습니다(상한 500건).",
	})
}

// keysOf returns the sorted keys of a set for stable output.
func keysOf(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
