package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// OIDCFlowState is what one Authorization Code login leg needs to remember until its
// callback arrives. Silent records a prompt=none attempt: the callback then treats the
// provider's "no session" answer as an ordinary outcome rather than a failure.
type OIDCFlowState struct {
	Nonce    string
	Verifier string
	ReturnTo string
	Silent   bool
}

// SaveOIDCFlowState persists a short-lived OIDC login-flow state (state → nonce + PKCE verifier
// + validated same-origin return path + silent flag)
// so the Authorization Code callback can validate it even if it lands on a different instance or
// after a restart. Opportunistically prunes entries older than 10 minutes.
func (s *SQLStore) SaveOIDCFlowState(ctx context.Context, state string, fs OIDCFlowState, createdAt time.Time) error {
	cutoff := createdAt.Add(-10 * time.Minute).UTC().Format(time.RFC3339Nano)
	_, _ = s.db.ExecContext(ctx, s.bind(`DELETE FROM oidc_flow_states WHERE created_at < ?`), cutoff)
	silent := 0
	if fs.Silent {
		silent = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO oidc_flow_states (state, nonce, verifier, return_to, silent, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(state) DO UPDATE SET nonce=excluded.nonce, verifier=excluded.verifier, return_to=excluded.return_to, silent=excluded.silent, created_at=excluded.created_at`),
		state, fs.Nonce, fs.Verifier, fs.ReturnTo, silent, createdAt.UTC().Format(time.RFC3339Nano))
	return err
}

// TakeOIDCFlowState atomically consumes a flow state: it returns the stored state and deletes
// the row. found is false if the state is unknown or older than the 10-minute TTL.
func (s *SQLStore) TakeOIDCFlowState(ctx context.Context, state string) (fs OIDCFlowState, found bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OIDCFlowState{}, false, err
	}
	defer tx.Rollback()

	var createdAt string
	var silent int
	row := tx.QueryRowContext(ctx, s.bind(`SELECT nonce, verifier, return_to, silent, created_at FROM oidc_flow_states WHERE state = ?`), state)
	if err = row.Scan(&fs.Nonce, &fs.Verifier, &fs.ReturnTo, &silent, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return OIDCFlowState{}, false, nil
		}
		return OIDCFlowState{}, false, err
	}
	fs.Silent = silent != 0

	// Consume inside the same transaction. A concurrent consumer can read the row before the
	// first DELETE commits on PostgreSQL, so RowsAffected is the portable single-winner guard.
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM oidc_flow_states WHERE state = ?`), state)
	if err != nil {
		return OIDCFlowState{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return OIDCFlowState{}, false, err
	}
	if affected == 0 {
		return OIDCFlowState{}, false, nil
	}
	if affected != 1 {
		return OIDCFlowState{}, false, fmt.Errorf("consume oidc flow state: deleted %d rows", affected)
	}
	if err := tx.Commit(); err != nil {
		return OIDCFlowState{}, false, err
	}

	// Consume regardless of age (single-use).
	if ts, perr := time.Parse(time.RFC3339Nano, createdAt); perr == nil && time.Since(ts) > 10*time.Minute {
		return OIDCFlowState{}, false, nil
	}
	return fs, true, nil
}
