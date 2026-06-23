package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handlePods returns the multi-pod operations map: every gateway pod's last heartbeat, build
// version, and settings-convergence state. GET /admin/pods?stale_s=
func (s *Server) handlePods(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	staleAfter := 90 * time.Second
	if v := strings.TrimSpace(r.URL.Query().Get("stale_s")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 3600 {
			staleAfter = time.Duration(n) * time.Second
		}
	}
	pods, err := s.db.ListPods(r.Context(), staleAfter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "pods_failed")
		return
	}
	live, stale, converged := 0, 0, 0
	for _, p := range pods {
		if p.Stale {
			stale++
		} else {
			live++
		}
		if p.UpToDate {
			converged++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pods": pods,
		"summary": map[string]int{
			"total": len(pods), "live": live, "stale": stale, "converged": converged,
		},
		"stale_s": int(staleAfter.Seconds()),
		"note":    "각 게이트웨이 파드의 하트비트·빌드·런타임 설정 수렴 상태입니다. up_to_date=false는 아직 최신 설정을 적용하지 않은 파드, stale=true는 최근 하트비트가 없는 파드입니다.",
	})
}
