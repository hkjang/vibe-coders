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

// SessionSummary is a rolled-up view of one coding session (request_logs.session_id) for the
// flight-recorder session list.
type SessionSummary struct {
	SessionID   string  `json:"session_id"`
	Requests    int     `json:"requests"`
	FirstSeen   string  `json:"first_seen"`
	LastSeen    string  `json:"last_seen"`
	Models      int     `json:"models"`
	APIKeys     int     `json:"api_keys"`
	Errors      int     `json:"errors"`
	TotalTokens int     `json:"total_tokens"`
	CostKRW     float64 `json:"cost_krw"`
}

// SessionRiskMarkers maps a session's request_ids to the governance/risk signals attached to
// them, so the flight recorder can overlay "where in the session a secret/policy block/risky
// code happened". Each map is keyed by request_id.
type SessionRiskMarkers struct {
	Secrets      map[string]int    `json:"secrets"`       // request_id -> secret event count
	PolicyBlocks map[string]int    `json:"policy_blocks"` // request_id -> non-allow policy decisions
	CodeRisk     map[string]string `json:"code_risk"`     // request_id -> code verdict risk
}

// SessionRiskMarkersFor collects the governance/risk signals tied to a session's requests via
// joins on request_logs.session_id (bounded to 3 grouped queries, not per-request).
func (s *SQLStore) SessionRiskMarkersFor(ctx context.Context, sessionID string) (SessionRiskMarkers, error) {
	m := SessionRiskMarkers{Secrets: map[string]int{}, PolicyBlocks: map[string]int{}, CodeRisk: map[string]string{}}

	secretRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT se.request_id, COUNT(*)
		FROM secret_events se JOIN request_logs r ON se.request_id = r.id
		WHERE r.session_id = ? AND se.request_id <> ''
		GROUP BY se.request_id`), sessionID)
	if err != nil {
		return m, err
	}
	for secretRows.Next() {
		var id string
		var n int
		if err := secretRows.Scan(&id, &n); err != nil {
			secretRows.Close()
			return m, err
		}
		m.Secrets[id] = n
	}
	secretRows.Close()

	polRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT p.request_id, COUNT(*)
		FROM policy_decision_events p JOIN request_logs r ON p.request_id = r.id
		WHERE r.session_id = ? AND p.request_id <> '' AND LOWER(p.decision) NOT IN ('allow', 'allowed', 'pass')
		GROUP BY p.request_id`), sessionID)
	if err != nil {
		return m, err
	}
	for polRows.Next() {
		var id string
		var n int
		if err := polRows.Scan(&id, &n); err != nil {
			polRows.Close()
			return m, err
		}
		m.PolicyBlocks[id] = n
	}
	polRows.Close()

	cvRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT cv.request_id, COALESCE(cv.risk, '')
		FROM code_verify_results cv JOIN request_logs r ON cv.request_id = r.id
		WHERE r.session_id = ? AND cv.has_code = 1`), sessionID)
	if err != nil {
		return m, err
	}
	for cvRows.Next() {
		var id, risk string
		if err := cvRows.Scan(&id, &risk); err != nil {
			cvRows.Close()
			return m, err
		}
		m.CodeRisk[id] = risk
	}
	cvRows.Close()

	return m, nil
}

// RecentSessions groups request_logs by session_id since a cutoff, newest activity first.
// Sessions with an empty session_id (anonymous/no client session) are excluded.
func (s *SQLStore) RecentSessions(ctx context.Context, since time.Time, limit int) ([]SessionSummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(`
		SELECT r.session_id,
			COUNT(*),
			MIN(r.created_at),
			MAX(r.created_at),
			COUNT(DISTINCT r.model),
			COUNT(DISTINCT r.api_key_id),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.session_id <> '' AND r.created_at >= ?
		GROUP BY r.session_id
		ORDER BY MAX(r.created_at) DESC
		LIMIT ?
	`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionSummary{}
	for rows.Next() {
		var x SessionSummary
		if err := rows.Scan(&x.SessionID, &x.Requests, &x.FirstSeen, &x.LastSeen,
			&x.Models, &x.APIKeys, &x.Errors, &x.TotalTokens, &x.CostKRW); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
