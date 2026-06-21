package proxy

import (
	"net/http"
	"time"
)

// opsCard is one "today's things to watch" tile on the operations home.
type opsCard struct {
	Key    string `json:"key"`
	Title  string `json:"title"`
	Status string `json:"status"` // ok | warn | critical | unknown
	Value  string `json:"value"`
	Detail string `json:"detail"`
	Link   string `json:"link"`
}

// worse returns the higher-severity of two statuses.
func worseStatus(a, b string) string {
	rank := map[string]int{"ok": 0, "unknown": 1, "warn": 2, "critical": 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// handleOpsHome aggregates the day's operational signals (cost spike, degraded provider, risky
// skills, MCP failures, Text2SQL blocks, ClickHouse lag) into prioritized cards.
// GET /admin/ops/home
func (s *Server) handleOpsHome(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	since := time.Now().UTC().Add(-24 * time.Hour)
	cards := []opsCard{}

	// 1) Cost spike — upward cost anomalies (7d baseline vs 24h recent, z≥3).
	cost := opsCard{Key: "cost_spike", Title: "비용 폭주", Status: "ok", Value: "정상", Link: "#/billing"}
	if anomalies, err := s.db.CostAnomalies(ctx, 7*24*time.Hour, 24*time.Hour, 3.0); err == nil {
		up := 0
		topZ := 0.0
		topScope := ""
		for _, a := range anomalies {
			if a.Direction == "up" {
				up++
				if a.ZScore > topZ {
					topZ, topScope = a.ZScore, a.Scope+":"+a.ScopeValue
				}
			}
		}
		if up > 0 {
			cost.Status = "warn"
			if topZ >= 5 {
				cost.Status = "critical"
			}
			cost.Value = itoaProxy(up) + "건"
			cost.Detail = "최고 z=" + ftoa(topZ) + " (" + topScope + ")"
		}
	} else {
		cost.Status, cost.Value = "unknown", "-"
	}
	cards = append(cards, cost)

	// 2) Degraded provider — provider health score below threshold over the last 24h.
	prov := opsCard{Key: "degraded_provider", Title: "Provider 상태", Status: "ok", Value: "정상", Link: "#/routing/health"}
	if scores, err := s.db.ProviderHealthScores(ctx, since); err == nil {
		degraded := 0
		worst := ""
		worstScore := 101
		for _, p := range scores {
			if p.Requests > 0 && p.Score < 70 {
				degraded++
				if p.Score < worstScore {
					worstScore, worst = p.Score, p.Provider
				}
			}
		}
		if degraded > 0 {
			prov.Status = "warn"
			if worstScore < 50 {
				prov.Status = "critical"
			}
			prov.Value = itoaProxy(degraded) + "개"
			prov.Detail = "최저 " + worst + " (" + itoaProxy(worstScore) + "점)"
		}
	} else {
		prov.Status, prov.Value = "unknown", "-"
	}
	cards = append(cards, prov)

	// 3) Risky skills — production skills with high-severity security findings.
	risk := opsCard{Key: "risky_skills", Title: "위험 Skill", Status: "ok", Value: "없음", Link: "#/skills"}
	if skills, err := s.db.ListSkills(ctx, "production"); err == nil {
		flagged := 0
		example := ""
		for _, sk := range skills {
			if scanSkillSecurity(sk).HighCount > 0 {
				flagged++
				if example == "" {
					example = sk.Name
				}
			}
		}
		if flagged > 0 {
			risk.Status, risk.Value, risk.Detail = "critical", itoaProxy(flagged)+"개", "예: "+example
		}
	} else {
		risk.Status, risk.Value = "unknown", "-"
	}
	cards = append(cards, risk)

	// 4) MCP failures — tool-call error rate over the last 24h.
	mcp := opsCard{Key: "mcp_failures", Title: "MCP 실패", Status: "ok", Value: "정상", Link: "#/mcp"}
	if calls, errs, err := s.db.ToolMetricsSince(ctx, since); err == nil && calls > 0 {
		rate := float64(errs) / float64(calls)
		mcp.Value = itoaProxy(int(errs)) + "/" + itoaProxy(int(calls))
		if rate >= 0.2 {
			mcp.Status, mcp.Detail = "critical", "오류율 "+ftoa(rate*100)+"%"
		} else if rate >= 0.05 {
			mcp.Status, mcp.Detail = "warn", "오류율 "+ftoa(rate*100)+"%"
		}
	} else if err != nil {
		mcp.Status, mcp.Value = "unknown", "-"
	}
	cards = append(cards, mcp)

	// 5) Text2SQL blocks — rejected/high-risk Text2SQL queries over the last 24h.
	t2s := opsCard{Key: "text2sql_blocks", Title: "Text2SQL 차단", Status: "ok", Value: "없음", Link: "#/text2sql"}
	if logs, err := s.db.RiskyText2SQLLogs(ctx, since, 70, 200); err == nil {
		rejected := 0
		for _, l := range logs {
			if !l.Valid {
				rejected++
			}
		}
		if rejected > 0 {
			t2s.Status = "warn"
			if rejected >= 20 {
				t2s.Status = "critical"
			}
			t2s.Value, t2s.Detail = itoaProxy(rejected)+"건", "차단된 쿼리"
		}
	} else {
		t2s.Status, t2s.Value = "unknown", "-"
	}
	cards = append(cards, t2s)

	// 6) ClickHouse lag — pending fact-retry batches (only meaningful when the sink is on).
	ch := s.chConf()
	chCard := opsCard{Key: "clickhouse_lag", Title: "ClickHouse 적재", Status: "ok", Value: "정상", Link: "#/dwdashboard/clickhouse"}
	if ch.URL == "" {
		chCard.Status, chCard.Value, chCard.Detail = "ok", "미사용", "ClickHouse sink 미설정"
	} else if n, err := s.db.CountClickHouseFactRetries(ctx); err == nil {
		if n > 0 {
			chCard.Status = "warn"
			if n >= 50 {
				chCard.Status = "critical"
			}
			chCard.Value, chCard.Detail = itoaProxy(n)+"배치", "재시도 대기 중인 fact"
		}
	} else {
		chCard.Status, chCard.Value = "unknown", "-"
	}
	cards = append(cards, chCard)

	overall := "ok"
	for _, c := range cards {
		overall = worseStatus(overall, c.Status)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_hours": 24, "overall": overall, "cards": cards,
		"generated_at": time.Now().UTC().Format(time.RFC3339),
	})
}
