package proxy

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// handleMultiModelLeaderboard aggregates stored multi-model judgements into a per-model
// leaderboard ("which model keeps winning"): appearances, average judge score, pass rate, and
// wins (times it had the top score in its run). GET /admin/chat-test/multi-run/leaderboard?team=&days=
func (s *Server) handleMultiModelLeaderboard(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	team := strings.TrimSpace(r.URL.Query().Get("team"))
	sinceRFC := ""
	days := 0
	if d := strings.TrimSpace(r.URL.Query().Get("days")); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 {
			days = n
			sinceRFC = time.Now().UTC().AddDate(0, 0, -n).Format(time.RFC3339Nano)
		}
	}
	rows, err := s.db.MultiModelJudgementRows(r.Context(), team, sinceRFC)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "leaderboard_failed")
		return
	}

	type agg struct {
		model      string
		appear     int
		sum        float64
		passes     int
		wins       int
	}
	stats := map[string]*agg{}
	get := func(m string) *agg {
		if stats[m] == nil {
			stats[m] = &agg{model: m}
		}
		return stats[m]
	}
	// Group rows by run to determine the per-run winner (highest total score).
	byRun := map[string][]int{} // runID -> indices into rows
	for i, row := range rows {
		byRun[row.RunID] = append(byRun[row.RunID], i)
		a := get(row.Model)
		a.appear++
		a.sum += row.TotalScore
		if row.Verdict == "pass" {
			a.passes++
		}
	}
	for _, idxs := range byRun {
		best, bestScore := "", -1.0
		for _, i := range idxs {
			if rows[i].Verdict == "fail" {
				continue
			}
			if rows[i].TotalScore > bestScore {
				bestScore = rows[i].TotalScore
				best = rows[i].Model
			}
		}
		if best != "" {
			get(best).wins++
		}
	}

	out := make([]map[string]any, 0, len(stats))
	for _, a := range stats {
		avg := 0.0
		passRate := 0.0
		if a.appear > 0 {
			avg = a.sum / float64(a.appear)
			passRate = float64(a.passes) / float64(a.appear)
		}
		out = append(out, map[string]any{
			"model": a.model, "appearances": a.appear, "avg_score": round1(avg),
			"pass_rate": round1(passRate * 100), "wins": a.wins,
		})
	}
	// Rank by wins, then avg score.
	sort.Slice(out, func(i, j int) bool {
		wi, wj := out[i]["wins"].(int), out[j]["wins"].(int)
		if wi != wj {
			return wi > wj
		}
		return out[i]["avg_score"].(float64) > out[j]["avg_score"].(float64)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"team": team, "days": days, "runs": len(byRun), "leaderboard": out,
		"note": "저장된 자동 평가(judge) 결과 기준. wins = 해당 run에서 최고 점수를 받은 횟수. 평가를 실행한 run만 포함.",
	})
}
