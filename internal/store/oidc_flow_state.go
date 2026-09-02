package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SaveOIDCFlowState persists a short-lived OIDC login-flow state (state → nonce + PKCE verifier
// + validated same-origin return path)
// so the Authorization Code callback can validate it even if it lands on a different instance or
// after a restart. Opportunistically prunes entries older than 10 minutes.
func (s *SQLStore) SaveOIDCFlowState(ctx context.Context, state, nonce, verifier, returnTo string, createdAt time.Time) error {
	cutoff := createdAt.Add(-10 * time.Minute).UTC().Format(time.RFC3339Nano)
	_, _ = s.db.ExecContext(ctx, s.bind(`DELETE FROM oidc_flow_states WHERE created_at < ?`), cutoff)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO oidc_flow_states (state, nonce, verifier, return_to, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(state) DO UPDATE SET nonce=excluded.nonce, verifier=excluded.verifier, return_to=excluded.return_to, created_at=excluded.created_at`),
		state, nonce, verifier, returnTo, createdAt.UTC().Format(time.RFC3339Nano))
	return err
}

// TakeOIDCFlowState atomically consumes a flow state: it returns the nonce/verifier/return path and deletes
// the row. found is false if the state is unknown or older than the 10-minute TTL.
func (s *SQLStore) TakeOIDCFlowState(ctx context.Context, state string) (nonce, verifier, returnTo string, found bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", "", false, err
	}
	defer tx.Rollback()

	var createdAt string
	row := tx.QueryRowContext(ctx, s.bind(`SELECT nonce, verifier, return_to, created_at FROM oidc_flow_states WHERE state = ?`), state)
	if err = row.Scan(&nonce, &verifier, &returnTo, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", "", false, nil
		}
		return "", "", "", false, err
	}

	// Consume inside the same transaction. A concurrent consumer can read the row before the
	// first DELETE commits on PostgreSQL, so RowsAffected is the portable single-winner guard.
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM oidc_flow_states WHERE state = ?`), state)
	if err != nil {
		return "", "", "", false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return "", "", "", false, err
	}
	if affected == 0 {
		return "", "", "", false, nil
	}
	if affected != 1 {
		return "", "", "", false, fmt.Errorf("consume oidc flow state: deleted %d rows", affected)
	}
	if err := tx.Commit(); err != nil {
		return "", "", "", false, err
	}

	// Consume regardless of age (single-use).
	if ts, perr := time.Parse(time.RFC3339Nano, createdAt); perr == nil && time.Since(ts) > 10*time.Minute {
		return "", "", "", false, nil
	}
	return nonce, verifier, returnTo, true, nil
}
