package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

func (s *SQLStore) CreateAuthUser(ctx context.Context, user AuthUser) error {
	now := time.Now().UTC()
	if user.CreatedAt.IsZero() {
		user.CreatedAt = now
	}
	if user.UpdatedAt.IsZero() {
		user.UpdatedAt = user.CreatedAt
	}
	if user.Status == "" {
		user.Status = "active"
	}
	if user.Role == "" {
		user.Role = "developer"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO users (id, email, password_hash, name, role, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			email = excluded.email,
			password_hash = excluded.password_hash,
			name = excluded.name,
			role = excluded.role,
			status = excluded.status,
			updated_at = excluded.updated_at`),
		user.ID, user.Email, user.PasswordHash, user.Name, user.Role, user.Status, formatTime(user.CreatedAt), formatTime(user.UpdatedAt))
	return err
}

func (s *SQLStore) AuthUserByEmail(ctx context.Context, email string) (AuthUser, bool, error) {
	var user AuthUser
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, email, password_hash, COALESCE(name, ''), role, status, created_at, updated_at
		FROM users WHERE email = ?`), email).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return AuthUser{}, false, nil
	}
	if err != nil {
		return AuthUser{}, false, err
	}
	user.CreatedAt = parseOptionalTime(createdAt)
	user.UpdatedAt = parseOptionalTime(updatedAt)
	return user, true, nil
}

func (s *SQLStore) AuthUserByID(ctx context.Context, id string) (AuthUser, bool, error) {
	var user AuthUser
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, email, password_hash, COALESCE(name, ''), role, status, created_at, updated_at
		FROM users WHERE id = ?`), id).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return AuthUser{}, false, nil
	}
	if err != nil {
		return AuthUser{}, false, err
	}
	user.CreatedAt = parseOptionalTime(createdAt)
	user.UpdatedAt = parseOptionalTime(updatedAt)
	return user, true, nil
}

func (s *SQLStore) ListAuthUsers(ctx context.Context) ([]AuthUser, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, email, password_hash, COALESCE(name, ''), role, status, created_at, updated_at FROM users ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuthUser{}
	for rows.Next() {
		var user AuthUser
		var createdAt, updatedAt string
		if err := rows.Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.Role, &user.Status, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		user.CreatedAt = parseOptionalTime(createdAt)
		user.UpdatedAt = parseOptionalTime(updatedAt)
		out = append(out, user)
	}
	return out, rows.Err()
}

// UpdateAuthUserRoleStatus applies a partial role/status update (empty = keep).
func (s *SQLStore) UpdateAuthUserRoleStatus(ctx context.Context, id, role, status string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE users SET
			role = CASE WHEN ? = '' THEN role ELSE ? END,
			status = CASE WHEN ? = '' THEN status ELSE ? END,
			updated_at = ?
		WHERE id = ?`), role, role, status, status, formatTime(time.Now().UTC()), id)
	return err
}

// RevokeAuthSessionsForUser revokes every active session for one user — used when
// an account is deactivated so its access tokens stop working immediately.
func (s *SQLStore) RevokeAuthSessionsForUser(ctx context.Context, userID string) error {
	now := formatTime(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`), now, userID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`), now, userID)
	return err
}

func (s *SQLStore) UpsertAuthTeam(ctx context.Context, team AuthTeam) error {
	now := time.Now().UTC()
	if team.CreatedAt.IsZero() {
		team.CreatedAt = now
	}
	if team.UpdatedAt.IsZero() {
		team.UpdatedAt = team.CreatedAt
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO teams (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`),
		team.ID, team.Name, formatTime(team.CreatedAt), formatTime(team.UpdatedAt))
	return err
}

func (s *SQLStore) ListAuthTeams(ctx context.Context) ([]AuthTeam, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, created_at, updated_at FROM teams ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuthTeam{}
	for rows.Next() {
		var team AuthTeam
		var createdAt, updatedAt string
		if err := rows.Scan(&team.ID, &team.Name, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		team.CreatedAt = parseOptionalTime(createdAt)
		team.UpdatedAt = parseOptionalTime(updatedAt)
		out = append(out, team)
	}
	return out, rows.Err()
}

func (s *SQLStore) AuthTeamByIDOrName(ctx context.Context, value string) (AuthTeam, bool, error) {
	if value == "" {
		return AuthTeam{}, false, nil
	}
	var team AuthTeam
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, created_at, updated_at
		FROM teams
		WHERE id = ? OR LOWER(name) = LOWER(?)
		ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
		LIMIT 1`), value, value, value).Scan(&team.ID, &team.Name, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return AuthTeam{}, false, nil
	}
	if err != nil {
		return AuthTeam{}, false, err
	}
	team.CreatedAt = parseOptionalTime(createdAt)
	team.UpdatedAt = parseOptionalTime(updatedAt)
	return team, true, nil
}

func (s *SQLStore) UpsertMembership(ctx context.Context, m UserTeamMembership) error {
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO user_team_memberships (user_id, team_id, role, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, team_id) DO UPDATE SET role = excluded.role`),
		m.UserID, m.TeamID, m.Role, formatTime(m.CreatedAt))
	return err
}

// SetUserTeam replaces a user's team memberships with a single team (empty teamID
// removes all memberships). Keeps PrimaryTeamForUser deterministic.
func (s *SQLStore) SetUserTeam(ctx context.Context, userID, teamID, role string) error {
	if _, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM user_team_memberships WHERE user_id = ?`), userID); err != nil {
		return err
	}
	if teamID == "" {
		return nil
	}
	return s.UpsertMembership(ctx, UserTeamMembership{UserID: userID, TeamID: teamID, Role: role, CreatedAt: time.Now().UTC()})
}

func (s *SQLStore) PrimaryTeamForUser(ctx context.Context, userID string) (string, error) {
	var teamID string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT team_id FROM user_team_memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`), userID).Scan(&teamID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return teamID, err
}

func (s *SQLStore) InsertAuthSession(ctx context.Context, sessionID, userID, ip, userAgent string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO auth_sessions (id, user_id, ip, user_agent, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`), sessionID, userID, ip, userAgent, formatTime(expiresAt), formatTime(time.Now().UTC()))
	return err
}

func (s *SQLStore) RevokeAuthSession(ctx context.Context, sessionID string) error {
	now := formatTime(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ?`), now, sessionID)
	return err
}

// AuthSessionInfo is a user-facing view of an active session for the session-management UI.
type AuthSessionInfo struct {
	ID        string `json:"id"`
	IP        string `json:"ip"`
	UserAgent string `json:"user_agent"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
	SSOLinked bool   `json:"sso_linked"` // true when tied to a Keycloak sid
}

// ListActiveAuthSessionsForUser returns the user's non-revoked, unexpired sessions, newest first.
func (s *SQLStore) ListActiveAuthSessionsForUser(ctx context.Context, userID string) ([]AuthSessionInfo, error) {
	now := formatTime(time.Now().UTC())
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(ip,''), COALESCE(user_agent,''), created_at, expires_at, COALESCE(kc_sid,'')
		FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
		ORDER BY created_at DESC`), userID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuthSessionInfo{}
	for rows.Next() {
		var si AuthSessionInfo
		var kcSID string
		if err := rows.Scan(&si.ID, &si.IP, &si.UserAgent, &si.CreatedAt, &si.ExpiresAt, &kcSID); err != nil {
			return nil, err
		}
		si.SSOLinked = kcSID != ""
		out = append(out, si)
	}
	return out, rows.Err()
}

// RevokeAuthSessionOwned revokes a single session only if it belongs to userID (returns whether
// a row was affected), so users can't revoke other people's sessions.
func (s *SQLStore) RevokeAuthSessionOwned(ctx context.Context, sessionID, userID string) (bool, error) {
	now := formatTime(time.Now().UTC())
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`), now, sessionID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		// Also revoke refresh tokens bound to that session.
		_, _ = s.db.ExecContext(ctx, s.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`), now, sessionID)
	}
	return n > 0, nil
}

// RevokeOtherAuthSessionsForUser revokes all of a user's active sessions except keepSessionID
// ("log out everywhere else"). Returns the number of sessions revoked.
func (s *SQLStore) RevokeOtherAuthSessionsForUser(ctx context.Context, userID, keepSessionID string) (int, error) {
	now := formatTime(time.Now().UTC())
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`), now, userID, keepSessionID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	_, _ = s.db.ExecContext(ctx, s.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND session_id <> ? AND revoked_at IS NULL`), now, userID, keepSessionID)
	return int(n), nil
}

// LinkAuthSessionKeycloakSID records the Keycloak session id (sid claim) on an internal
// session so front-/back-channel logout can target the exact browser session.
func (s *SQLStore) LinkAuthSessionKeycloakSID(ctx context.Context, sessionID, kcSID string) error {
	if kcSID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET kc_sid = ? WHERE id = ?`), kcSID, sessionID)
	return err
}

// RevokeAuthSessionsByKeycloakSID revokes the internal session(s) linked to a Keycloak sid
// and returns the affected user ids (for refresh-token cleanup + audit). Used by OIDC
// front-channel and back-channel logout when the OP supplies a sid.
func (s *SQLStore) RevokeAuthSessionsByKeycloakSID(ctx context.Context, kcSID string) ([]string, error) {
	if kcSID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT DISTINCT user_id FROM auth_sessions WHERE kc_sid = ? AND revoked_at IS NULL`), kcSID)
	if err != nil {
		return nil, err
	}
	users := []string{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return nil, err
		}
		users = append(users, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := formatTime(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE auth_sessions SET revoked_at = ? WHERE kc_sid = ? AND revoked_at IS NULL`), now, kcSID); err != nil {
		return nil, err
	}
	// Best-effort: revoke refresh tokens for the affected users.
	for _, u := range users {
		_, _ = s.db.ExecContext(ctx, s.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`), now, u)
	}
	return users, nil
}

func (s *SQLStore) AuthSessionActive(ctx context.Context, sessionID string) (bool, error) {
	var expiresAt, revokedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT expires_at, COALESCE(revoked_at, '') FROM auth_sessions WHERE id = ?`), sessionID).Scan(&expiresAt, &revokedAt)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return revokedAt == "" && parseOptionalTime(expiresAt).After(time.Now().UTC()), nil
}

func (s *SQLStore) InsertRefreshToken(ctx context.Context, token RefreshTokenRecord) error {
	if token.CreatedAt.IsZero() {
		token.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO refresh_tokens (id, user_id, session_id, token_hash, expires_at, created_at, rotated_from)
		VALUES (?, ?, ?, ?, ?, ?, ?)`),
		token.ID, token.UserID, token.SessionID, token.TokenHash, formatTime(token.ExpiresAt), formatTime(token.CreatedAt), token.RotatedFrom)
	return err
}

func (s *SQLStore) RefreshTokenByHash(ctx context.Context, hash string) (RefreshTokenRecord, bool, error) {
	var token RefreshTokenRecord
	var revokedAt, expiresAt, createdAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, user_id, session_id, token_hash, COALESCE(revoked_at, ''), expires_at, created_at, COALESCE(rotated_from, '')
		FROM refresh_tokens WHERE token_hash = ?`), hash).Scan(&token.ID, &token.UserID, &token.SessionID, &token.TokenHash, &revokedAt, &expiresAt, &createdAt, &token.RotatedFrom)
	if err == sql.ErrNoRows {
		return RefreshTokenRecord{}, false, nil
	}
	if err != nil {
		return RefreshTokenRecord{}, false, err
	}
	token.RevokedAt = parseOptionalTime(revokedAt)
	token.ExpiresAt = parseOptionalTime(expiresAt)
	token.CreatedAt = parseOptionalTime(createdAt)
	return token, true, nil
}

func (s *SQLStore) RevokeRefreshToken(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`), formatTime(time.Now().UTC()), id)
	return err
}

func (s *SQLStore) InsertAuditEvent(ctx context.Context, e AuthEvent) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO audit_events (id, event_type, actor_user_id, api_key_id, team_id, ip, user_agent, detail, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.EventType, e.ActorUserID, e.APIKeyID, e.TeamID, e.IP, e.UserAgent, e.Detail, formatTime(e.CreatedAt))
	return err
}

func (s *SQLStore) ListAuditEvents(ctx context.Context, limit int) ([]AuthEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, event_type, COALESCE(actor_user_id, ''), COALESCE(api_key_id, ''), COALESCE(team_id, ''),
		COALESCE(ip, ''), COALESCE(user_agent, ''), COALESCE(detail, ''), created_at
		FROM audit_events ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuthEvent{}
	for rows.Next() {
		var e AuthEvent
		var createdAt string
		if err := rows.Scan(&e.ID, &e.EventType, &e.ActorUserID, &e.APIKeyID, &e.TeamID, &e.IP, &e.UserAgent, &e.Detail, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = parseOptionalTime(createdAt)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *SQLStore) InsertLoginAttempt(ctx context.Context, email string, success bool, ip, userAgent, reason string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO login_attempts (id, email, success, ip, user_agent, reason, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`),
		"login_"+auditHash(email+"|"+time.Now().UTC().Format(time.RFC3339Nano)), email, boolInt(success), ip, userAgent, reason, formatTime(time.Now().UTC()))
	return err
}

func (s *SQLStore) RevokeAPIKey(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`), formatTime(time.Now().UTC()), id)
	return err
}

func encodeStringList(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	b, _ := json.Marshal(values)
	return string(b)
}

func decodeStringList(raw string) []string {
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	if out == nil {
		out = []string{}
	}
	return out
}

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatTime(value)
}

func parseOptionalTime(raw string) time.Time {
	if raw == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed
	}
	return time.Time{}
}
