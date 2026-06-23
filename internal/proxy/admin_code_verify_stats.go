package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleCodeVerifyStats aggregates persisted code verification verdicts by model — an
// accumulated, cross-request "which model writes the riskiest code" leaderboard that
// complements the per-run multi-model code-verify view. Read-only; no raw code.
// GET /admin/code-verify/stats?days=
func (s *Server) handleCodeVerifyStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	days := 30
	if d := strings.TrimSpace(r.URL.Query().Get("days")); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	stats, err := s.db.CodeVerifyModelStats(r.Context(), since, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "code_verify_stats_failed")
		return
	}
	totals := map[string]int{"verdicts": 0, "risk_high": 0, "risk_medium": 0, "secret_findings": 0}
	for _, s := range stats {
		totals["verdicts"] += s.Verdicts
		totals["risk_high"] += s.RiskHigh
		totals["risk_medium"] += s.RiskMedium
		totals["secret_findings"] += s.SecretFindings
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days":       days,
		"models":     stats,
		"totals":     totals,
		"note":       "영속된 코드 검증 verdict(코드 포함 응답)를 모델별로 집계했습니다. 응답 텍스트 캡처가 켜진 요청만 포함됩니다. 원문 코드는 포함되지 않습니다.",
		"high_first": true,
	})
}
