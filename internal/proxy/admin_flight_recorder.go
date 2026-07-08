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

// lastUserPromptPreview returns a compact, whitespace-collapsed snippet of the last user-role
// prompt in a request (redacted text only), for the flight-recorder "last message" column.
func lastUserPromptPreview(prompts []store.PromptPreview) string {
	for i := len(prompts) - 1; i >= 0; i-- {
		if strings.EqualFold(prompts[i].Role, "user") {
			return truncateRunes(strings.Join(strings.Fields(prompts[i].RedactedText), " "), 160)
		}
	}
	return ""
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
			"last_message": lastUserPromptPreview(rq.Prompts),
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

	summary := sessionRCASummary(len(events), errorCount, secretReqs, policyBlockReqs, highRiskCodeReqs, len(models), totalCost)

	writeJSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID,
		"events":     events,
		"summary":    summary,
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

// sessionRCASummary produces a rule-based (air-gapped, no LLM) Korean RCA summary of a session:
// an overall verdict plus the findings that drove it. Used so an operator can read the gist of
// a session before scanning the timeline.
func sessionRCASummary(requests, errors, secretReqs, policyBlocks, highRiskCode, models int, totalCost float64) map[string]any {
	findings := []string{}
	if errors > 0 {
		findings = append(findings, itoaProxy(errors)+"건 요청이 오류(HTTP 4xx/5xx)로 종료됨")
	}
	if secretReqs > 0 {
		findings = append(findings, itoaProxy(secretReqs)+"개 요청에서 시크릿이 탐지/마스킹됨")
	}
	if policyBlocks > 0 {
		findings = append(findings, itoaProxy(policyBlocks)+"개 요청이 정책에 의해 차단됨")
	}
	if highRiskCode > 0 {
		findings = append(findings, itoaProxy(highRiskCode)+"개 요청이 high 위험도 코드 응답을 포함")
	}

	verdict := "정상"
	if secretReqs > 0 || policyBlocks > 0 || highRiskCode > 0 {
		verdict = "위험"
	} else if errors > 0 {
		verdict = "주의"
	}

	headline := itoaProxy(requests) + "건 요청"
	if models > 0 {
		headline += " · 모델 " + itoaProxy(models) + "종"
	}
	if requests > 0 {
		headline += " · 오류율 " + itoaProxy(errors*100/requests) + "%"
	}
	if totalCost > 0 {
		headline += " · 비용 " + krwLabel(totalCost)
	}
	if len(findings) == 0 {
		findings = append(findings, "위험 신호 없음 — 모든 요청 정상 처리")
	}

	return map[string]any{
		"verdict":  verdict,
		"headline": headline,
		"findings": findings,
	}
}

// krwLabel renders a KRW amount compactly for summary text.
func krwLabel(v float64) string {
	if v >= 10000 {
		return itoaProxy(int(v/10000)) + "만원"
	}
	return itoaProxy(int(v+0.5)) + "원"
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
