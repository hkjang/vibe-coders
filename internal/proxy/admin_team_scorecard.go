package proxy

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// teamScore is one team's AI maturity scorecard. Each dimension is 0..100; nil-equivalent
// dimensions (no data) are reported as -1 and excluded from the overall average.
type teamScore struct {
	Team            string  `json:"team"`
	Requests        int64   `json:"requests"`
	CostKRW         float64 `json:"cost_krw"`
	CostEfficiency  float64 `json:"cost_efficiency"`
	SuccessRate     float64 `json:"success_rate"`
	CacheRate       float64 `json:"cache_rate"`
	SkillReuse      float64 `json:"skill_reuse"`
	MCPSuccess      float64 `json:"mcp_success"`
	Text2SQLSuccess float64 `json:"text2sql_success"`
	PolicyComply    float64 `json:"policy_compliance"`
	Satisfaction    float64 `json:"satisfaction"`
	Overall         float64 `json:"overall"`
	Grade           string  `json:"grade"`
}

// handleTeamScorecard scores every active team's AI maturity across cost/quality/safety
// dimensions from existing per-team aggregates. Admin only. Supports ?format=csv.
// GET /admin/teams/scorecard?window=30d
func (s *Server) handleTeamScorecard(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")

	teams, err := s.db.ListTeams(ctx)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "teams_failed")
		return
	}
	feedback, _ := s.db.SkillFeedbackStats(ctx)

	scores := []teamScore{}
	costPerReq := []float64{} // for fleet-relative cost efficiency
	type raw struct {
		ts  teamScore
		cpr float64 // cost per request (-1 if none)
	}
	raws := []raw{}

	for _, t := range teams {
		teamID := t.Team
		if teamID == "" || teamID == "unassigned" || t.Requests == 0 {
			continue
		}
		keys := []string{teamID}
		if at, found, _ := s.db.AuthTeamByIDOrName(ctx, teamID); found {
			keys = uniqueNonEmpty(teamID, at.ID, at.Name)
		}

		dash, _ := s.db.TeamDashboardSince(ctx, keys, since, 1)
		extras, _ := s.db.TeamQualityExtras(ctx, keys, since)
		skills, _ := s.db.TeamPopularSkills(ctx, keys, since, 100)
		mcp, _ := s.db.TeamMCPTools(ctx, keys, since, 100)
		events, _ := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{TeamID: teamID, Since: since, Limit: 5000})

		ts := teamScore{Team: teamID, Requests: dash.Totals.Requests, CostKRW: round1(dash.Totals.CostKRW)}
		ts.SuccessRate = round1(dash.Totals.SuccessRate * 100)
		ts.CacheRate = round1(extras.CacheRate * 100)

		// Skill reuse: how often the team leans on reusable skills vs raw requests (capped 100).
		var skillRuns int64
		for _, sk := range skills {
			skillRuns += sk.Runs
		}
		ts.SkillReuse = -1
		if ts.Requests > 0 {
			ts.SkillReuse = round1(clamp100(float64(skillRuns) / float64(ts.Requests) * 100))
		}

		// MCP success.
		var mcpCalls, mcpErrors int64
		for _, m := range mcp {
			mcpCalls += m.Calls
			mcpErrors += m.Errors
		}
		ts.MCPSuccess = -1
		if mcpCalls > 0 {
			ts.MCPSuccess = round1((1 - float64(mcpErrors)/float64(mcpCalls)) * 100)
		}

		// Text2SQL success.
		ts.Text2SQLSuccess = -1
		if extras.Text2SQLTotal > 0 {
			ts.Text2SQLSuccess = round1(float64(extras.Text2SQLOK) / float64(extras.Text2SQLTotal) * 100)
		}

		// Policy compliance = 1 - blocked/total decisions.
		blocked := 0
		for _, e := range events {
			if strings.EqualFold(e.Decision, "block") {
				blocked++
			}
		}
		ts.PolicyComply = 100
		if len(events) > 0 {
			ts.PolicyComply = round1((1 - float64(blocked)/float64(len(events))) * 100)
		}

		// Satisfaction: average feedback over the skills the team actually uses.
		var ratingSum, ratingN float64
		for _, sk := range skills {
			if fb, ok := feedback[sk.SkillName]; ok && fb.Count > 0 {
				ratingSum += fb.AvgRating
				ratingN++
			}
		}
		ts.Satisfaction = -1
		if ratingN > 0 {
			ts.Satisfaction = round1(ratingSum / ratingN / 5 * 100)
		}

		cpr := -1.0
		if ts.Requests > 0 {
			cpr = dash.Totals.CostKRW / float64(ts.Requests)
			costPerReq = append(costPerReq, cpr)
		}
		raws = append(raws, raw{ts: ts, cpr: cpr})
	}

	// Cost efficiency is fleet-relative: cheaper-than-median cost/request scores higher.
	median := medianFloat(costPerReq)
	for i := range raws {
		ts := raws[i].ts
		ts.CostEfficiency = -1
		if raws[i].cpr >= 0 {
			if raws[i].cpr <= 0 || median <= 0 {
				ts.CostEfficiency = 100
			} else {
				ts.CostEfficiency = round1(clamp100(median / raws[i].cpr * 100))
			}
		}
		ts.Overall, ts.Grade = scorecardOverall(ts)
		scores = append(scores, ts)
	}
	sort.SliceStable(scores, func(i, j int) bool { return scores[i].Overall > scores[j].Overall })

	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		writeTeamScorecardCSV(w, scores)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window":       since.UTC().Format(time.RFC3339),
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"teams":        scores,
		"note":         "팀별 AI 성숙도 점수(0~100). -1은 데이터 없음(평균 제외). cost_efficiency는 요청당 비용의 fleet 중앙값 대비 상대 점수입니다.",
	})
}

// scorecardOverall averages the available (>=0) dimensions and assigns a letter grade.
func scorecardOverall(ts teamScore) (float64, string) {
	dims := []float64{ts.CostEfficiency, ts.SuccessRate, ts.CacheRate, ts.SkillReuse, ts.MCPSuccess, ts.Text2SQLSuccess, ts.PolicyComply, ts.Satisfaction}
	var sum float64
	var n float64
	for _, d := range dims {
		if d >= 0 {
			sum += d
			n++
		}
	}
	if n == 0 {
		return 0, "N/A"
	}
	overall := round1(sum / n)
	switch {
	case overall >= 85:
		return overall, "A"
	case overall >= 70:
		return overall, "B"
	case overall >= 55:
		return overall, "C"
	default:
		return overall, "D"
	}
}

func clamp100(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func medianFloat(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	s := append([]float64{}, vals...)
	sort.Float64s(s)
	mid := len(s) / 2
	if len(s)%2 == 1 {
		return s[mid]
	}
	return (s[mid-1] + s[mid]) / 2
}

func writeTeamScorecardCSV(w http.ResponseWriter, scores []teamScore) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=team_scorecard.csv")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintln(w, "team,requests,cost_krw,overall,grade,cost_efficiency,success_rate,cache_rate,skill_reuse,mcp_success,text2sql_success,policy_compliance,satisfaction")
	for _, t := range scores {
		fmt.Fprintf(w, "%s,%d,%.1f,%.1f,%s,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f\n",
			csvEscapeField(t.Team), t.Requests, t.CostKRW, t.Overall, t.Grade,
			t.CostEfficiency, t.SuccessRate, t.CacheRate, t.SkillReuse, t.MCPSuccess, t.Text2SQLSuccess, t.PolicyComply, t.Satisfaction)
	}
}

func csvEscapeField(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}
