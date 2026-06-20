package proxy

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

// csvContains reports whether a comma-separated tag list contains value (case-insensitive,
// trimmed).
func csvContains(csv, value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return false
	}
	for _, p := range strings.Split(csv, ",") {
		if strings.ToLower(strings.TrimSpace(p)) == value {
			return true
		}
	}
	return false
}

// handleMeRecommendedModels recommends models for the caller's frequent task types using the
// admin-curated model usage tags (good_for / avoid_for / risk_note), plus annotates the models
// they already use. GET /me/recommended-models
func (s *Server) handleMeRecommendedModels(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := time.Now().UTC().AddDate(0, 0, -30)
	profile, err := s.db.BuildPersonalProfile(r.Context(), claims.Subject, since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	tags, err := s.db.ListModelUsageTags(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "tags_failed")
		return
	}

	// Per-task recommendations from the user's top task types.
	taskRecs := []map[string]any{}
	maxTasks := 5
	for i, tt := range profile.TopTaskTypes {
		if i >= maxTasks {
			break
		}
		recommend, avoid := []string{}, []string{}
		for _, t := range tags {
			if csvContains(t.GoodFor, tt.Key) {
				recommend = append(recommend, t.Model)
			}
			if csvContains(t.AvoidFor, tt.Key) {
				avoid = append(avoid, t.Model)
			}
		}
		if len(recommend) == 0 && len(avoid) == 0 {
			continue
		}
		taskRecs = append(taskRecs, map[string]any{
			"task_type": tt.Key, "requests": tt.Requests, "recommend": recommend, "avoid": avoid,
		})
	}

	// Annotate the models the user already uses with their tags (risk warnings included).
	tagByModel := map[string]map[string]any{}
	for _, t := range tags {
		tagByModel[t.Model] = map[string]any{"good_for": t.GoodFor, "avoid_for": t.AvoidFor, "risk_note": t.RiskNote}
	}
	yourModels := []map[string]any{}
	for _, m := range profile.TopModels {
		row := map[string]any{"model": m.Key, "requests": m.Requests}
		if tg, ok := tagByModel[m.Key]; ok {
			row["tags"] = tg
		}
		yourModels = append(yourModels, row)
	}

	// Team winners: top models by wins from the team's recent multi-model judge results.
	teamWinners := s.teamModelWinners(r, claims.TeamID, 3)

	writeJSON(w, http.StatusOK, map[string]any{
		"task_recommendations": taskRecs,
		"your_models":          yourModels,
		"team_winners":         teamWinners,
		"tagged_model_count":   len(tags),
		"note":                 "최근 30일 작업 유형·관리자 모델 용도 태그·팀 멀티모델 평가 결과를 결합한 추천입니다.",
	})
}

// teamModelWinners aggregates the team's recent (90d) multi-model judge results into the top-N
// models by wins (times a model had the top score in its run), then avg score.
func (s *Server) teamModelWinners(r *http.Request, team string, topN int) []map[string]any {
	if strings.TrimSpace(team) == "" {
		return []map[string]any{}
	}
	since := time.Now().UTC().AddDate(0, 0, -90).Format(time.RFC3339Nano)
	rows, err := s.db.MultiModelJudgementRows(r.Context(), team, since)
	if err != nil || len(rows) == 0 {
		return []map[string]any{}
	}
	type agg struct {
		appear int
		sum    float64
		wins   int
	}
	stats := map[string]*agg{}
	get := func(m string) *agg {
		if stats[m] == nil {
			stats[m] = &agg{}
		}
		return stats[m]
	}
	byRun := map[string][]int{}
	for i, row := range rows {
		byRun[row.RunID] = append(byRun[row.RunID], i)
		a := get(row.Model)
		a.appear++
		a.sum += row.TotalScore
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
	for model, a := range stats {
		avg := 0.0
		if a.appear > 0 {
			avg = a.sum / float64(a.appear)
		}
		out = append(out, map[string]any{"model": model, "wins": a.wins, "avg_score": round1(avg), "appearances": a.appear})
	}
	sort.Slice(out, func(i, j int) bool {
		wi, wj := out[i]["wins"].(int), out[j]["wins"].(int)
		if wi != wj {
			return wi > wj
		}
		return out[i]["avg_score"].(float64) > out[j]["avg_score"].(float64)
	})
	if len(out) > topN {
		out = out[:topN]
	}
	return out
}
