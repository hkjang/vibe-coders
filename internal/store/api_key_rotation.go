package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

var ErrAPIKeyConflict = errors.New("api key snapshot is no longer current or usable")

const MaxAPIKeyRotationGrace = 24 * time.Hour

type APIKeyRotationResult struct {
	APIKeyRecord
	GraceEndsAt time.Time
}

// APIKeyRevision binds the browser's reviewed public metadata to the complete
// persisted snapshot without disclosing the credential hash. It is an opaque
// concurrency token, never an authorization credential.
func APIKeyRevision(key APIKeyRecord) string {
	_, values := apiKeySnapshotPredicate(key)
	encoded, err := json.Marshal(values)
	if err != nil {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(key.KeyHash))
	_, _ = mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil))
}

// apiKeySnapshotPredicate compares every persisted security and metadata field.
// UpsertAPIKey has no revision column; a timestamp-only check cannot protect a
// reviewed key from concurrent scope, ownership, restriction, or status edits.
func apiKeySnapshotPredicate(key APIKeyRecord) (string, []any) {
	return `id = ? AND name = ? AND key_hash = ? AND COALESCE(owner, '') = ? AND COALESCE(team, '') = ?
		AND COALESCE(user_id, '') = ? AND COALESCE(service_account_id, '') = ? AND COALESCE(role, '') = ? AND status = ?
		AND COALESCE(scopes, '[]') = ? AND COALESCE(allowed_ips, '[]') = ? AND COALESCE(allowed_models, '[]') = ?
		AND COALESCE(denied_models, '[]') = ? AND COALESCE(allowed_providers, '[]') = ? AND COALESCE(denied_providers, '[]') = ?
		AND COALESCE(budget_limit_krw, 0) = ? AND COALESCE(expires_at, '') = ? AND COALESCE(revoked_at, '') = ? AND created_at = ?`,
		[]any{key.ID, key.Name, key.KeyHash, key.Owner, key.Team, key.UserID, key.ServiceAccountID, key.Role, key.Status,
			encodeStringList(key.Scopes), encodeStringList(key.AllowedIPs), encodeStringList(key.AllowedModels),
			encodeStringList(key.DeniedModels), encodeStringList(key.AllowedProviders), encodeStringList(key.DeniedProviders),
			key.BudgetLimitKRW, formatOptionalTime(key.ExpiresAt), formatOptionalTime(key.RevokedAt), formatTime(key.CreatedAt)}
}

// RotateAPIKey commits replacement insertion, original revocation and both
// lifecycle audit events together. The first statement acquires the write lock
// and compares the server's authorized snapshot, without a read/upgrade window.
// It is not a replay service: a repeated rotation of the old key conflicts and
// cannot recover a plaintext secret after the successful response is lost.
func (s *SQLStore) RotateAPIKey(ctx context.Context, expected APIKeyRecord, newID, newHash string, grace time.Duration, created, rotated AuthEvent) (APIKeyRotationResult, error) {
	if expected.ID == "" || expected.KeyHash == "" || expected.UserID == "" || newID == "" || newID == expected.ID || newHash == "" || newHash == expected.KeyHash ||
		created.ID == "" || rotated.ID == "" || created.ID == rotated.ID || created.EventType != "api_key_created" || rotated.EventType != "api_key_rotated" ||
		created.APIKeyID != newID || rotated.APIKeyID != expected.ID || created.ActorUserID != expected.UserID || rotated.ActorUserID != expected.UserID {
		return APIKeyRotationResult{}, errors.New("invalid API key rotation or audit")
	}
	if grace < 0 || grace > MaxAPIKeyRotationGrace || grace%time.Second != 0 {
		return APIKeyRotationResult{}, errors.New("invalid API key rotation grace period")
	}
	now := time.Now().UTC()
	if expected.Status != "active" || !expected.RevokedAt.IsZero() || !expected.ExpiresAt.IsZero() && !expected.ExpiresAt.After(now) {
		return APIKeyRotationResult{}, ErrAPIKeyConflict
	}
	graceEnd := now.Add(grace)
	if !expected.ExpiresAt.IsZero() && expected.ExpiresAt.Before(graceEnd) {
		graceEnd = expected.ExpiresAt
	}
	status, revokedAt, expiresAt := "revoked", formatTime(now), formatOptionalTime(expected.ExpiresAt)
	if grace > 0 {
		status, revokedAt, expiresAt = "active", "", formatTime(graceEnd)
	}
	predicate, args := apiKeySnapshotPredicate(expected)
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return APIKeyRotationResult{}, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return APIKeyRotationResult{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.bind(`UPDATE api_keys SET status = ?, revoked_at = ?, expires_at = ? WHERE `+predicate+
		` AND NOT EXISTS (SELECT 1 FROM api_key_rotations WHERE old_key_id = api_keys.id OR old_key_hash = api_keys.key_hash)`), append([]any{status, revokedAt, expiresAt}, args...)...)
	if err != nil {
		return APIKeyRotationResult{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return APIKeyRotationResult{}, err
	}
	if affected != 1 || !expected.ExpiresAt.IsZero() && !expected.ExpiresAt.After(time.Now()) || grace > 0 && !graceEnd.After(time.Now()) {
		return APIKeyRotationResult{}, ErrAPIKeyConflict
	}
	// PostgreSQL READ COMMITTED can wait for a preceding rotation whose grace
	// was capped to the unchanged original expiry. Re-read lineage after the row
	// lock: a subquery from the UPDATE's earlier snapshot is not sufficient.
	if err := s.requireUnrotatedAPIKey(ctx, tx, expected); err != nil {
		return APIKeyRotationResult{}, err
	}
	// Copy the locked row in SQL, including all restrictions. Only credential
	// identity, status and lifecycle timestamps change; raw secrets never persist.
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO api_keys
		(id, name, key_hash, owner, team, user_id, service_account_id, role, status,
		 scopes, allowed_ips, allowed_models, denied_models, allowed_providers, denied_providers,
		 budget_limit_krw, expires_at, revoked_at, created_at)
		SELECT ?, name, ?, owner, team, user_id, service_account_id, role, 'active',
		 scopes, allowed_ips, allowed_models, denied_models, allowed_providers, denied_providers,
		 budget_limit_krw, ?, '', ? FROM api_keys WHERE id = ?`), newID, newHash, formatOptionalTime(expected.ExpiresAt), formatTime(now), expected.ID)
	if err != nil {
		return APIKeyRotationResult{}, err
	}
	// This lineage is lifecycle state, not audit data: retention must not remove
	// it. Keep tombstones even when a key is deleted, preventing ID resurrection.
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO api_key_rotations (old_key_id, old_key_hash, new_key_id, grace_ends_at, created_at) VALUES (?, ?, ?, ?, ?)`),
		expected.ID, expected.KeyHash, newID, formatTime(graceEnd), formatTime(now)); err != nil {
		return APIKeyRotationResult{}, err
	}
	created.CreatedAt, rotated.CreatedAt = now, now
	if err := s.insertAuditEvent(ctx, tx, created); err != nil {
		return APIKeyRotationResult{}, err
	}
	if err := s.insertAuditEvent(ctx, tx, rotated); err != nil {
		return APIKeyRotationResult{}, err
	}
	if err := commitAPIKeyTransaction(ctx, conn, tx); err != nil {
		return APIKeyRotationResult{}, err
	}
	next := expected
	next.ID, next.KeyHash, next.CreatedAt = newID, newHash, now
	return APIKeyRotationResult{APIKeyRecord: next, GraceEndsAt: graceEnd}, nil
}

func commitAPIKeyTransaction(ctx context.Context, conn *sql.Conn, tx *sql.Tx) error {
	if err := tx.Commit(); err != nil {
		// SQLite can leave the SQL transaction open after a failed COMMIT has
		// already marked database/sql's Tx done. Never return that connection
		// to the pool with uncommitted keys or audit rows still visible.
		_ = tx.Rollback()
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, cleanupErr := conn.ExecContext(cleanupCtx, "ROLLBACK"); cleanupErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		return err
	}
	return nil
}

func (s *SQLStore) requireUnrotatedAPIKey(ctx context.Context, tx *sql.Tx, key APIKeyRecord) error {
	var rotated bool
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT EXISTS (SELECT 1 FROM api_key_rotations WHERE old_key_id = ? OR old_key_hash = ?)`), key.ID, key.KeyHash).Scan(&rotated); err != nil {
		return err
	}
	if rotated {
		return ErrAPIKeyConflict
	}
	return nil
}

// UpdateAPIKeyScopes changes only scopes, never upserting an old full record.
// In particular an in-flight scope edit cannot resurrect a just-rotated key or
// restore its old owner, team or restrictions. The scope audit is atomic too.
func (s *SQLStore) UpdateAPIKeyScopes(ctx context.Context, expected APIKeyRecord, scopes []string, audit AuthEvent) error {
	if expected.ID == "" || expected.UserID == "" || audit.ID == "" || audit.EventType != "api_key_scopes_updated" || audit.APIKeyID != expected.ID || audit.ActorUserID != expected.UserID {
		return errors.New("invalid API key scope snapshot or audit")
	}
	if expected.Status != "active" || !expected.RevokedAt.IsZero() {
		return ErrAPIKeyConflict
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	predicate, args := apiKeySnapshotPredicate(expected)
	result, err := tx.ExecContext(ctx, s.bind(`UPDATE api_keys SET scopes = ? WHERE `+predicate+
		` AND NOT EXISTS (SELECT 1 FROM api_key_rotations WHERE old_key_id = api_keys.id OR old_key_hash = api_keys.key_hash)`), append([]any{encodeStringList(scopes)}, args...)...)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrAPIKeyConflict
	}
	if err := s.requireUnrotatedAPIKey(ctx, tx, expected); err != nil {
		return err
	}
	if err := s.insertAuditEvent(ctx, tx, audit); err != nil {
		return err
	}
	return commitAPIKeyTransaction(ctx, conn, tx)
}
