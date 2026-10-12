package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) rotateSelfServiceKey(w http.ResponseWriter, r *http.Request, me meIdentity, existing store.APIKeyRecord) {
	input, err := readKeyRotationRequest(w, r)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid rotation review, reason or grace period", "invalid_request_error", "invalid_key_rotation")
		return
	}
	if input.ExpectedRevision != "" && subtle.ConstantTimeCompare([]byte(input.ExpectedRevision), []byte(store.APIKeyRevision(existing))) != 1 {
		writeOpenAIError(w, http.StatusConflict, "key changed since review; reload before rotating", "invalid_request_error", "key_rotation_conflict")
		return
	}
	if existing.Status != "active" || !existing.RevokedAt.IsZero() || !existing.ExpiresAt.IsZero() && !existing.ExpiresAt.After(time.Now()) {
		writeOpenAIError(w, http.StatusConflict, "key is no longer active or has expired", "invalid_request_error", "key_rotation_conflict")
		return
	}
	role := authContextFromAPIKey(existing).Role
	if !scopesWithin(existing.Scopes, me.Scopes) || !validRole(role) || !validRole(me.Role) || role != me.Role && roleRank(role) >= roleRank(me.Role) {
		writeOpenAIError(w, http.StatusForbidden, "cannot rotate a key beyond your current authority", "permission_error", "scope_denied")
		return
	}
	teamID := existing.Team
	if teamID != me.TeamID {
		team, found, lookupErr := s.db.AuthTeamByIDOrName(r.Context(), teamID)
		if lookupErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "could not verify key team", "server_error", "key_rotation_authority_unavailable")
			return
		}
		if found {
			teamID = team.ID
		}
		if teamID != me.TeamID {
			writeOpenAIError(w, http.StatusForbidden, "key belongs to a different team", "permission_error", "scope_denied")
			return
		}
	}
	secret, err := generateAuthAPIKey(s.cfg.Auth.APIKeyPrefix)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "could not generate replacement key", "server_error", "key_generation_failed")
		return
	}
	hash := hashProxyKey(secret)
	id := "key_" + hash[:16]
	detail, _ := json.Marshal(map[string]any{"source_id": existing.ID, "replacement_id": id, "reason": input.Reason, "grace_seconds": input.GraceSeconds})
	created := store.AuthEvent{ID: newID("ae"), EventType: "api_key_created", APIKeyID: id, ActorUserID: me.UserID, TeamID: existing.Team, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: string(detail)}
	rotated := created
	rotated.ID, rotated.EventType, rotated.APIKeyID = newID("ae"), "api_key_rotated", existing.ID
	rec, err := s.db.RotateAPIKey(r.Context(), existing, id, hash, time.Duration(input.GraceSeconds)*time.Second, created, rotated)
	if errors.Is(err, store.ErrAPIKeyConflict) {
		writeOpenAIError(w, http.StatusConflict, "key changed or is no longer usable; reload before reviewing", "invalid_request_error", "key_rotation_conflict")
		return
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "could not confirm key rotation; check current keys before retrying", "server_error", "key_rotate_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rotated_from":  existing.ID,
		"grace_ends_at": rec.GraceEndsAt.Format(time.RFC3339Nano),
		"api_key":       map[string]any{"id": rec.ID, "name": rec.Name, "user_id": rec.UserID, "role": rec.Role, "scopes": rec.Scopes, "status": rec.Status},
		"secret":        secret,
	})
}
