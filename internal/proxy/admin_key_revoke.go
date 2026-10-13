package proxy

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"vibe-coders/internal/store"
)

func (s *Server) adminKeyActor(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok && claims.Subject != "" {
		return claims.Subject
	}
	return adminID(r)
}

func (s *Server) revokeAdminKey(w http.ResponseWriter, r *http.Request, existing store.APIKeyRecord, hard bool) {
	if hard {
		if claims, ok := s.currentAccessClaims(r); s.cfg.Auth.Enabled && (!ok || claims.Role != "super_admin") {
			writeOpenAIError(w, http.StatusForbidden, "hard delete requires super_admin", "permission_error", "super_admin_required")
			return
		}
	}
	input, err := readKeyReviewRequest(w, r, false)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid key review or reason", "invalid_request_error", "invalid_key_revoke")
		return
	}
	if input.ExpectedRevision != "" {
		revision, err := s.db.APIKeyRevision(r.Context(), existing)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "could not verify key review", "server_error", "key_revoke_authority_unavailable")
			return
		}
		if subtle.ConstantTimeCompare([]byte(input.ExpectedRevision), []byte(revision)) != 1 {
			writeOpenAIError(w, http.StatusConflict, "key changed since review", "invalid_request_error", "key_revoke_conflict")
			return
		}
	}
	actor := s.adminKeyActor(r)
	action, status := "api_key.status", "revoked"
	if hard {
		action, status = "api_key.delete", "deleted"
	}
	before := auditJSON(map[string]any{"id": existing.ID, "status": existing.Status})
	after := auditJSON(map[string]any{"id": existing.ID, "status": status, "reason": input.Reason, "hard_delete": hard})
	audit := store.AdminAuditLog{ID: newID("audit"), AdminID: actor, Action: action, BeforeValue: before, AfterValue: after}
	event := store.AuthEvent{ID: newID("ae"), EventType: "api_key_revoked", APIKeyID: existing.ID, ActorUserID: actor, TeamID: existing.Team, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: after}
	err = s.db.RevokeAdminAPIKey(r.Context(), existing, hard, audit, event)
	if errors.Is(err, store.ErrAPIKeyConflict) {
		writeOpenAIError(w, http.StatusConflict, "key changed since authorization", "invalid_request_error", "key_revoke_conflict")
		return
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "could not confirm key revocation; inspect current keys and audit before retrying", "server_error", "key_revoke_failed")
		return
	}
	s.runAdminPostChange(r, action, before, after, "")
	writeJSON(w, http.StatusOK, map[string]string{"id": existing.ID, "status": status})
}
