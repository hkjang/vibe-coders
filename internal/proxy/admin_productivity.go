package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleProductivity reports the AI-usage-vs-delivery correlation per repo: AI requests/tokens/
// cost alongside VCS commits / merge requests. GET /admin/productivity?days=30
func (s *Server) handleProductivity(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	rows, err := s.db.ProductivityByRepo(r.Context(), since, 200)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "productivity_failed")
		return
	}
	// Per-row cost-per-merged-MR signal (avoid divide-by-zero); aggregate totals.
	out := make([]map[string]any, 0, len(rows))
	var totReq, totMerged int64
	var totCost float64
	for _, x := range rows {
		totReq += x.AIRequests
		totMerged += x.Merged
		totCost += x.AICostKRW
		costPerMerged := 0.0
		if x.Merged > 0 {
			costPerMerged = x.AICostKRW / float64(x.Merged)
		}
		out = append(out, map[string]any{
			"repo": x.Repo, "ai_requests": x.AIRequests, "ai_tokens": x.AITokens, "ai_cost_krw": x.AICostKRW,
			"commits": x.Commits, "merge_requests": x.MergeRequests, "merged": x.Merged,
			"cost_per_merged_krw": costPerMerged,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days":   days,
		"repos":  out,
		"totals": map[string]any{"ai_requests": totReq, "merged": totMerged, "ai_cost_krw": totCost},
		"note":   "X-Vibe-Repo로 귀속된 AI 사용량과 VCS 이벤트(commit/merge_request)를 repo별로 상관 분석합니다. VCS 이벤트가 수집되지 않은 repo는 개발 산출이 0으로 표시됩니다.",
	})
}
