package proxy

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// narrativeSection is one prose block of the monthly report (title + narrative + key metrics).
type narrativeSection struct {
	Title     string         `json:"title"`
	Narrative string         `json:"narrative"`
	Metrics   map[string]any `json:"metrics,omitempty"`
}

// handleNarrativeReport assembles a human-readable monthly operations report (Korean prose) from
// existing aggregates — an executive narrative instead of raw dashboards. Read-only, no new data.
// GET /admin/reports/narrative?window=30d[&format=md]
func (s *Server) handleNarrativeReport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	periodDur := now.Sub(since)
	priorSince := since.Add(-periodDur)
	won := func(v float64) string { return "₩" + commaInt(v) }

	// Usage & cost: this period vs the equal prior period (computed by subtraction).
	curReq, curCost, curTok, _ := s.db.UsageSince(ctx, store.UsageFilter{Scope: "global", Since: since})
	wideReq, wideCost, _, _ := s.db.UsageSince(ctx, store.UsageFilter{Scope: "global", Since: priorSince})
	priorReq := wideReq - curReq
	if priorReq < 0 {
		priorReq = 0
	}
	priorCost := wideCost - curCost
	if priorCost < 0 {
		priorCost = 0
	}
	reqDelta := pctDelta(float64(curReq), float64(priorReq))
	costDelta := pctDelta(curCost, priorCost)

	sections := []narrativeSection{}

	sections = append(sections, narrativeSection{
		Title: "요약",
		Narrative: fmt.Sprintf("최근 %d일 동안 게이트웨이는 총 %s건의 요청을 처리했고 비용은 %s입니다. 직전 동일 기간 대비 요청은 %s, 비용은 %s 변동했습니다.",
			daysOf(periodDur), commaInt(float64(curReq)), won(curCost), signedPct(reqDelta), signedPct(costDelta)),
		Metrics: map[string]any{"requests": curReq, "cost_krw": round1(curCost), "tokens": curTok,
			"requests_delta_pct": reqDelta, "cost_delta_pct": costDelta},
	})

	// Teams: top by windowed cost.
	type teamCost struct {
		team string
		cost float64
		reqs int64
	}
	tcs := []teamCost{}
	if teams, err := s.db.ListTeams(ctx); err == nil {
		for _, t := range teams {
			if t.Team == "" || t.Team == "unassigned" {
				continue
			}
			keys := []string{t.Team}
			if at, found, _ := s.db.AuthTeamByIDOrName(ctx, t.Team); found {
				keys = uniqueNonEmpty(t.Team, at.ID, at.Name)
			}
			d, _ := s.db.TeamDashboardSince(ctx, keys, since, 1)
			if d.Totals.Requests > 0 {
				tcs = append(tcs, teamCost{t.Team, d.Totals.CostKRW, d.Totals.Requests})
			}
		}
	}
	sort.SliceStable(tcs, func(i, j int) bool { return tcs[i].cost > tcs[j].cost })
	topTeams := tcs
	if len(topTeams) > 5 {
		topTeams = topTeams[:5]
	}
	teamLines := []string{}
	teamMetrics := []map[string]any{}
	for _, t := range topTeams {
		teamLines = append(teamLines, fmt.Sprintf("%s(%s·%s건)", t.team, won(t.cost), commaInt(float64(t.reqs))))
		teamMetrics = append(teamMetrics, map[string]any{"team": t.team, "cost_krw": round1(t.cost), "requests": t.reqs})
	}
	teamNarr := "팀별 활동이 기록되지 않았습니다."
	if len(teamLines) > 0 {
		teamNarr = "비용 상위 팀: " + strings.Join(teamLines, ", ") + "."
	}
	sections = append(sections, narrativeSection{Title: "팀 활동", Narrative: teamNarr, Metrics: map[string]any{"top_teams": teamMetrics}})

	// Quality: model quality summary.
	if qs, err := s.db.ModelQualityScores(ctx, since); err == nil && len(qs) > 0 {
		sort.SliceStable(qs, func(i, j int) bool { return qs[i].QualityScore > qs[j].QualityScore })
		var sum float64
		for _, q := range qs {
			sum += q.QualityScore
		}
		avg := sum / float64(len(qs))
		best := qs[0]
		worst := qs[len(qs)-1]
		sections = append(sections, narrativeSection{
			Title: "품질",
			Narrative: fmt.Sprintf("평가된 %d개 모델의 평균 품질 점수는 %s점입니다. 최고는 %s(%s점), 최저는 %s(%s점)입니다.",
				len(qs), ftoa(avg), best.Model, ftoa(best.QualityScore), worst.Model, ftoa(worst.QualityScore)),
			Metrics: map[string]any{"avg_quality": round1(avg), "best_model": best.Model, "worst_model": worst.Model},
		})
	}

	// Safety: policy blocks, secrets, cost anomalies.
	blocks := 0
	if ev, err := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{Decision: "block", Since: since, Limit: 5000}); err == nil {
		blocks = len(ev)
	}
	secrets := 0
	if se, err := s.db.ListSecretEventsFiltered(ctx, store.SecretEventFilter{Since: since, Limit: 500}); err == nil {
		secrets = len(se)
	}
	anomalies := 0
	if an, err := s.db.CostAnomalies(ctx, 7*24*time.Hour, 24*time.Hour, 3); err == nil {
		anomalies = len(an)
	}
	sections = append(sections, narrativeSection{
		Title: "안전·거버넌스",
		Narrative: fmt.Sprintf("기간 중 정책 차단 %d건, secret 탐지 %d건이 기록됐고, 최근 비용 이상징후 %d건이 감지됐습니다.",
			blocks, secrets, anomalies),
		Metrics: map[string]any{"policy_blocks": blocks, "secret_events": secrets, "cost_anomalies": anomalies},
	})

	// Recommendations: derived from the figures above.
	recs := []string{}
	if costDelta > 15 {
		recs = append(recs, fmt.Sprintf("비용이 %s 증가했습니다. 비용 상위 팀과 모델 라우팅을 점검하세요.", signedPct(costDelta)))
	}
	if blocks >= 30 {
		recs = append(recs, fmt.Sprintf("정책 차단이 %d건입니다. 정책 어드바이저와 회귀 테스트로 의도치 않은 차단을 확인하세요.", blocks))
	}
	if secrets >= 10 {
		recs = append(recs, fmt.Sprintf("secret 탐지가 %d건입니다. Secret Firewall 차단 정책을 검토하세요.", secrets))
	}
	if anomalies > 0 {
		recs = append(recs, fmt.Sprintf("비용 이상징후 %d건 — 자동 조치(Remediation) 화면에서 대응 후보를 확인하세요.", anomalies))
	}
	if len(recs) == 0 {
		recs = append(recs, "특이사항이 없습니다. 현재 운영 상태는 안정적입니다.")
	}
	sections = append(sections, narrativeSection{Title: "권고", Narrative: strings.Join(recs, " "), Metrics: map[string]any{"items": recs}})

	if strings.EqualFold(r.URL.Query().Get("format"), "md") {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "# AI Gateway 운영 보고서 (%s ~ %s)\n\n", since.Format("2006-01-02"), now.Format("2006-01-02"))
		for _, sec := range sections {
			fmt.Fprintf(w, "## %s\n\n%s\n\n", sec.Title, sec.Narrative)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"period_start": since.UTC().Format(time.RFC3339),
		"period_end":   now.UTC().Format(time.RFC3339),
		"generated_at": now.UTC().Format(time.RFC3339),
		"sections":     sections,
		"note":         "기존 집계를 합성한 월간 운영 보고서입니다. ?format=md로 마크다운을 받을 수 있습니다.",
	})
}

// pctDelta returns the signed percent change from prior to cur, rounded to 1 decimal
// (0 prior → 0 to avoid divide-by-zero). round1 can't be used here — it clamps negatives.
func pctDelta(cur, prior float64) float64 {
	if prior <= 0 {
		return 0
	}
	return math.Round((cur-prior)/prior*1000) / 10
}

func signedPct(v float64) string {
	if v > 0 {
		return "+" + ftoa(v) + "%"
	}
	return ftoa(v) + "%"
}

func daysOf(d time.Duration) int { return int(d.Hours()/24 + 0.5) }

// commaInt formats a number with thousands separators (no decimals).
func commaInt(v float64) string {
	n := int64(math.Round(v))
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprintf("%d", n)
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, c)
	}
	if neg {
		return "-" + string(out)
	}
	return string(out)
}
