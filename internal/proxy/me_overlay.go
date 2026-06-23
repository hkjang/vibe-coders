package proxy

import (
	"net/http"
	"strings"
)

// handleMeOverlay returns a compact status snapshot for the caller — designed to be polled by an
// IDE extension or a small local panel so a developer sees, at a glance: which model vibe/auto
// resolves to, how much budget is used/left, and whether there are action items / connection
// problems. One fast call, no raw content. GET /me/overlay
func (s *Server) handleMeOverlay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	keyID, authCtx, keyOK := s.authenticateProxyContext(r)
	claims, jwtOK := s.currentAccessClaims(r)
	subject := ""
	if jwtOK {
		subject = strings.TrimSpace(claims.Subject)
	}
	if (!keyOK || authCtx == nil) && subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}

	authMode := "jwt"
	if keyOK && authCtx != nil {
		authMode = "proxy_key"
	}
	out := map[string]any{
		"auth_mode":     authMode,
		"default_model": firstNonEmpty(s.cfg.Upstream.DefaultModel, "vibe/auto"),
		"base_url":      requestOrigin(r) + "/v1",
	}

	// Budget/quota (needs a resolved key).
	if keyOK && keyID != "" && keyID != "anonymous" {
		if dec, err := s.checkQuotas(r.Context(), keyID, ""); err == nil {
			out["budget_ok"] = dec.Allowed
			out["used_krw"] = dec.CostKRW
			if dec.Quota.KRWLimit > 0 {
				out["budget_limit_krw"] = dec.Quota.KRWLimit
				remaining := dec.Quota.KRWLimit - dec.CostKRW
				if remaining < 0 {
					remaining = 0
				}
				out["budget_remaining_krw"] = remaining
			}
			if !dec.Allowed {
				out["budget_reason"] = dec.Reason
			}
		}
	}

	// Personal action items / top recommendation.
	if subject != "" {
		if recs, err := s.db.ListUserRecommendations(r.Context(), subject); err == nil {
			out["action_items"] = len(recs)
			if len(recs) > 0 {
				out["top_recommendation"] = recs[0].Title
				out["top_recommendation_savings_krw"] = recs[0].EstSavingsKRW
			}
		}
	}

	out["note"] = "코딩 중 IDE 패널/확장이 폴링하는 컴팩트 상태입니다. 상세는 내 홈(/me)에서 확인하세요."
	writeJSON(w, http.StatusOK, out)
}
