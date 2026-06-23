package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleCanaryStatus reports each canary policy's live enforced vs shadow activity and a
// suggested next rollout step — the "ramp it up?" view for staged policy enforcement.
// GET /admin/policies/canary-status?days=
func (s *Server) handleCanaryStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	days := 7
	if d := strings.TrimSpace(r.URL.Query().Get("days")); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 && n <= 90 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	stats, err := s.db.CanaryPolicyStats(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "canary_status_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days":     days,
		"policies": stats,
		"note":     "canary(rollout<100%) 정책별 실집행(enforced_acts) vs 섀도우(shadow_acts, 미적용 would-block) 비교입니다. 섀도우가 오탐 없이 의도대로면 suggested_next로 상향하세요. 차단 원문은 포함되지 않습니다.",
	})
}
