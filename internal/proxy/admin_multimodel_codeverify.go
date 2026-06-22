package proxy

import (
	"net/http"
	"sort"
	"strings"
)

// handleMultiRunCodeVerify runs the code verification gate over each model's stored response
// and ranks the models by code safety/quality — a "code-aware" leaderboard that complements
// the text-level diff. Stateless: computed from already-stored response previews, nothing new
// is persisted, and (per verifyCode) no raw code is returned — only risk/findings metadata.
// GET /admin/chat-test/multi-run/runs/{id}/code-verify
func (s *Server) handleMultiRunCodeVerify(w http.ResponseWriter, r *http.Request, runID string) {
	_, results, _, found, err := s.db.GetMultiModelRun(r.Context(), runID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "multi_run_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "run not found", "invalid_request_error", "not_found")
		return
	}

	riskRank := map[string]int{"none": 0, "low": 1, "medium": 2, "high": 3}

	type modelVerdict struct {
		Model      string           `json:"model"`
		Available  bool             `json:"available"`
		Report     codeVerifyReport `json:"report"`
		Score      int              `json:"score"` // 0-100, higher = safer/more verifiable code
		score      int
		riskOrder  int
		hasCodeInt int
	}

	verdicts := make([]*modelVerdict, 0, len(results))
	withCode := 0
	for _, res := range results {
		if res.Status != "ok" || strings.TrimSpace(res.ResponsePreview) == "" {
			verdicts = append(verdicts, &modelVerdict{Model: res.Model, Available: false})
			continue
		}
		rep := verifyCode(res.ResponsePreview)
		mv := &modelVerdict{Model: res.Model, Available: true, Report: rep, riskOrder: riskRank[rep.Risk]}
		if rep.HasCode {
			withCode++
			mv.hasCodeInt = 1
		}
		mv.Score = codeVerifyScore(rep)
		mv.score = mv.Score
		verdicts = append(verdicts, mv)
	}

	// Rank: code-bearing answers first, then by score desc, then lower risk, then model name.
	ranked := make([]*modelVerdict, len(verdicts))
	copy(ranked, verdicts)
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if a.Available != b.Available {
			return a.Available
		}
		if a.hasCodeInt != b.hasCodeInt {
			return a.hasCodeInt > b.hasCodeInt
		}
		if a.score != b.score {
			return a.score > b.score
		}
		if a.riskOrder != b.riskOrder {
			return a.riskOrder < b.riskOrder
		}
		return a.Model < b.Model
	})

	leaderboard := make([]map[string]any, 0, len(ranked))
	for rank, mv := range ranked {
		row := map[string]any{
			"rank":      rank + 1,
			"model":     mv.Model,
			"available": mv.Available,
		}
		if mv.Available {
			row["score"] = mv.Score
			row["risk"] = mv.Report.Risk
			row["has_code"] = mv.Report.HasCode
			row["block_count"] = mv.Report.BlockCount
			row["languages"] = mv.Report.Languages
			row["counts"] = mv.Report.Counts
		}
		leaderboard = append(leaderboard, row)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"run_id":            runID,
		"models_with_code":  withCode,
		"leaderboard":       leaderboard,
		"per_model":         verdicts,
		"note":              "코드 검증 점수는 저장된 응답 preview 기준입니다(정적 규칙·폐쇄망). 높을수록 위험 적고 테스트 가능성 높음. 원문 코드는 포함되지 않습니다.",
		"scoring_breakdown": "기본 100 − high*25 − medium*8 − syntax*5 + testable*5(상한 100)",
	})
}

// codeVerifyScore turns a verification report into a 0-100 code-safety/quality score.
// No code → neutral 50 (nothing to verify). With code: start at 100 and deduct for findings,
// reward verifiable (testable) blocks.
func codeVerifyScore(rep codeVerifyReport) int {
	if !rep.HasCode {
		return 50
	}
	score := 100
	score -= rep.Counts["high"] * 25
	score -= rep.Counts["medium"] * 8
	score -= rep.Counts["syntax"] * 5
	score += rep.Counts["testable"] * 5
	if score > 100 {
		score = 100
	}
	if score < 0 {
		score = 0
	}
	return score
}
