package proxy

import (
	"net/http"
	"sort"
	"time"
)

// incident is a ranked root-cause candidate the operator should look at first.
type incident struct {
	ID          string         `json:"id"`
	Severity    string         `json:"severity"` // critical | warning | info
	Category    string         `json:"category"`
	Title       string         `json:"title"`
	Summary     string         `json:"summary"`
	Evidence    map[string]any `json:"evidence,omitempty"`
	Actions     []string       `json:"recommended_actions"`
	Links       []string       `json:"links,omitempty"`
}

func severityRank(s string) int {
	switch s {
	case "critical":
		return 3
	case "warning":
		return 2
	case "info":
		return 1
	}
	return 0
}

// handleIncidentCandidates synthesizes provider health, cost anomalies, MCP failures, Text2SQL
// blocks, ClickHouse lag, and audit anomalies into ranked incident candidates with evidence and
// recommended actions. Only surfaces signals above threshold (unlike the always-on ops home).
// GET /admin/incidents/candidates
func (s *Server) handleIncidentCandidates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	since := time.Now().UTC().Add(-24 * time.Hour)
	incidents := []incident{}

	// Provider degradation — low health score / high 5xx / high fallback.
	if scores, err := s.db.ProviderHealthScores(ctx, since); err == nil {
		for _, p := range scores {
			if p.Requests < 10 || p.Score >= 70 {
				continue
			}
			sev := "warning"
			if p.Score < 50 {
				sev = "critical"
			}
			incidents = append(incidents, incident{
				ID: "provider:" + p.Provider, Severity: sev, Category: "provider",
				Title:   "Provider 저하: " + p.Provider + " (" + itoaProxy(p.Score) + "점)",
				Summary: "최근 24h 헬스 점수 하락 — 5xx/타임아웃/폴백 증가 가능.",
				Evidence: map[string]any{"score": p.Score, "requests": p.Requests, "rate_5xx": p.Rate5xx,
					"rate_429": p.Rate429, "timeouts": p.Timeouts, "fallback_rate": round1(p.FallbackRate * 100)},
				Actions: []string{"업스트림 상태/쿼터 점검", "라우팅에서 일시 강등 또는 폴백 우선순위 조정", "Provider Health 상세 확인"},
				Links:   []string{"#/routing/health"},
			})
		}
	}

	// Cost spike — upward cost anomalies.
	if anomalies, err := s.db.CostAnomalies(ctx, 7*24*time.Hour, 24*time.Hour, 3.0); err == nil {
		for _, a := range anomalies {
			if a.Direction != "up" {
				continue
			}
			sev := "warning"
			if a.ZScore >= 5 {
				sev = "critical"
			}
			incidents = append(incidents, incident{
				ID: "cost:" + a.Scope + ":" + a.ScopeValue, Severity: sev, Category: "cost",
				Title:   "비용 급증: " + a.Scope + " " + a.ScopeValue,
				Summary: "최근 24h 비용이 7일 기준 대비 비정상적으로 높습니다.",
				Evidence: map[string]any{"z_score": round1(a.ZScore), "recent_cost_krw": round1(a.RecentValue),
					"baseline_mean_krw": round1(a.BaselineMean)},
				Actions: []string{"해당 scope의 모델·요청 폭주 확인", "예산/쿼터 점검", "필요 시 변경 영향도 시뮬레이터로 차단안 검토"},
				Links:   []string{"#/billing", "#/changesets"},
			})
		}
	}

	// MCP failures — tool-call error rate.
	if calls, errs, err := s.db.ToolMetricsSince(ctx, since); err == nil && calls >= 20 {
		rate := float64(errs) / float64(calls)
		if rate >= 0.05 {
			sev := "warning"
			if rate >= 0.2 {
				sev = "critical"
			}
			incidents = append(incidents, incident{
				ID: "mcp:errors", Severity: sev, Category: "mcp",
				Title:    "MCP 도구 오류율 상승 (" + ftoa(rate*100) + "%)",
				Summary:  "최근 24h MCP tool 호출 실패가 임계치를 초과했습니다.",
				Evidence: map[string]any{"errors": errs, "calls": calls, "error_rate_pct": round1(rate * 100)},
				Actions:  []string{"MCP 업스트림 연결/인증 점검", "도구별 오류는 Agentic Timeline에서 확인", "위험 도구 일시 비활성화 검토"},
				Links:    []string{"#/mcp"},
			})
		}
	}

	// Text2SQL blocks — rejected queries surge.
	if logs, err := s.db.RiskyText2SQLLogs(ctx, since, 70, 200); err == nil {
		rejected := 0
		for _, l := range logs {
			if !l.Valid {
				rejected++
			}
		}
		if rejected >= 5 {
			sev := "info"
			if rejected >= 20 {
				sev = "warning"
			}
			incidents = append(incidents, incident{
				ID: "text2sql:blocks", Severity: sev, Category: "text2sql",
				Title:    "Text2SQL 차단 증가 (" + itoaProxy(rejected) + "건)",
				Summary:  "최근 24h 거부된 Text2SQL 쿼리가 늘었습니다(검증 실패/위험).",
				Evidence: map[string]any{"rejected": rejected},
				Actions:  []string{"위험 요청 큐 검토", "스키마 권한/용어 사전 보완", "반복 차단 패턴은 골든/가이드로 전환"},
				Links:    []string{"#/text2sql"},
			})
		}
	}

	// ClickHouse lag — fact-retry backlog.
	if s.chConf().URL != "" {
		if n, err := s.db.CountClickHouseFactRetries(ctx); err == nil && n > 0 {
			sev := "warning"
			if n >= 50 {
				sev = "critical"
			}
			incidents = append(incidents, incident{
				ID: "clickhouse:lag", Severity: sev, Category: "clickhouse",
				Title:    "ClickHouse 적재 지연 (" + itoaProxy(n) + " 배치 대기)",
				Summary:  "fact 적재가 실패해 재시도 큐가 쌓였습니다 — DW 분석이 최신이 아닐 수 있습니다.",
				Evidence: map[string]any{"pending_batches": n},
				Actions:  []string{"ClickHouse 연결/디스크 점검", "fact-retry 재처리 실행", "워커 상태판에서 sink 상태 확인"},
				Links:    []string{"#/dwdashboard/clickhouse", "#/ops-home"},
			})
		}
	}

	// Audit anomalies — recent critical/warning anomaly events.
	if events, err := s.db.ListAnomalyEvents(ctx, 50); err == nil {
		recentCrit := 0
		for _, e := range events {
			if e.Severity == "critical" || e.Severity == "high" {
				recentCrit++
			}
		}
		if recentCrit > 0 {
			incidents = append(incidents, incident{
				ID: "anomaly:events", Severity: "warning", Category: "anomaly",
				Title:    "이상탐지 이벤트 " + itoaProxy(recentCrit) + "건",
				Summary:  "비용/사용량 이상탐지가 최근 다수 발생했습니다.",
				Evidence: map[string]any{"high_severity_events": recentCrit},
				Actions:  []string{"이상탐지 이벤트 상세 확인", "관련 scope의 사용 패턴 점검"},
				Links:    []string{"#/security"},
			})
		}
	}

	sort.SliceStable(incidents, func(i, j int) bool {
		return severityRank(incidents[i].Severity) > severityRank(incidents[j].Severity)
	})
	counts := map[string]int{"critical": 0, "warning": 0, "info": 0}
	for _, in := range incidents {
		counts[in.Severity]++
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_hours": 24, "incidents": incidents, "counts": counts, "total": len(incidents),
		"note": "임계치를 넘은 신호만 장애 후보로 노출합니다. 근거·추천 조치·관련 링크 포함.",
	})
}
