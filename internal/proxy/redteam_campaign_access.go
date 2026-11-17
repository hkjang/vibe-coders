package proxy

import (
	"net/http"
	"strings"
)

// Classify a denial after the existing authorizer has rejected the operation.
// The UI marker only selects an error representation; it never grants access.
func (s *Server) writeRedTeamCampaignAccessDenied(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Vibe-UI")), "app") {
		w.Header().Set("Cache-Control", "no-store")
		user, authenticated, valid := s.appUIBootstrapIdentity(r)
		if r.Context().Err() != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "현재 권한을 확인하지 못했습니다.", "server_error", "redteam_authority_unavailable")
			return
		}
		if valid && authenticated && user != nil {
			writeOpenAIError(w, http.StatusForbidden, "현재 계정에는 이 캠페인 작업 권한이 없습니다.", "permission_error", "redteam_permission_denied")
			return
		}
	}
	writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
}
