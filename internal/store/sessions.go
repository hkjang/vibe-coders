package store

import (
	"context"
	"database/sql"
	"time"
)

type InferredSessionRecord struct {
	IdentityHash string
	SessionID    string
	LastSeen     time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func (s *SQLStore) InferredSessionByIdentity(ctx context.Context, identityHash string) (InferredSessionRecord, bool, error) {
	var rec InferredSessionRecord
	var lastSeen, createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT identity_hash, session_id, last_seen, created_at, updated_at
		FROM inferred_sessions WHERE identity_hash = ?`), identityHash).
		Scan(&rec.IdentityHash, &rec.SessionID, &lastSeen, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return InferredSessionRecord{}, false, nil
	}
	if err != nil {
		return InferredSessionRecord{}, false, err
	}
	rec.LastSeen = parseOptionalTime(lastSeen)
	rec.CreatedAt = parseOptionalTime(createdAt)
	rec.UpdatedAt = parseOptionalTime(updatedAt)
	return rec, true, nil
}

func (s *SQLStore) UpsertInferredSession(ctx context.Context, rec InferredSessionRecord) error {
	now := time.Now().UTC()
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = now
	}
	if rec.UpdatedAt.IsZero() {
		rec.UpdatedAt = now
	}
	if rec.LastSeen.IsZero() {
		rec.LastSeen = rec.UpdatedAt
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO inferred_sessions (identity_hash, session_id, last_seen, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(identity_hash) DO UPDATE SET
			session_id = excluded.session_id,
			last_seen = excluded.last_seen,
			updated_at = excluded.updated_at`),
		rec.IdentityHash, rec.SessionID, formatTime(rec.LastSeen), formatTime(rec.CreatedAt), formatTime(rec.UpdatedAt))
	return err
}

func (s *SQLStore) DeleteExpiredInferredSessions(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM inferred_sessions WHERE last_seen < ?`), formatTime(cutoff))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
