package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// OIDCLoginExchange is the server-side half of the short, one-time browser code
// returned after an OIDC callback. Only a SHA-256 hash of the browser code is stored.
type OIDCLoginExchange struct {
	CodeHash    string
	UserID      string
	TeamID      string
	KeycloakSID string
	CreatedAt   time.Time
}

// SaveOIDCLoginExchange persists a login exchange for up to two minutes and prunes stale rows.
func (s *SQLStore) SaveOIDCLoginExchange(ctx context.Context, exchange OIDCLoginExchange) error {
	if exchange.CreatedAt.IsZero() {
		exchange.CreatedAt = time.Now().UTC()
	}
	cutoff := exchange.CreatedAt.Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	_, _ = s.db.ExecContext(ctx, s.bind(`DELETE FROM oidc_login_exchanges WHERE created_at < ?`), cutoff)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO oidc_login_exchanges
		(code_hash, user_id, team_id, keycloak_sid, created_at) VALUES (?, ?, ?, ?, ?)`),
		exchange.CodeHash, exchange.UserID, exchange.TeamID, exchange.KeycloakSID,
		exchange.CreatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

// TakeOIDCLoginExchange atomically consumes a browser exchange code. Exactly one
// process can win, even when the callback and SPA land on different gateway pods.
func (s *SQLStore) TakeOIDCLoginExchange(ctx context.Context, codeHash string) (OIDCLoginExchange, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OIDCLoginExchange{}, false, err
	}
	defer tx.Rollback()

	var exchange OIDCLoginExchange
	var createdAt string
	err = tx.QueryRowContext(ctx, s.bind(`SELECT code_hash, user_id, team_id, keycloak_sid, created_at
		FROM oidc_login_exchanges WHERE code_hash = ?`), codeHash).
		Scan(&exchange.CodeHash, &exchange.UserID, &exchange.TeamID, &exchange.KeycloakSID, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return OIDCLoginExchange{}, false, nil
	}
	if err != nil {
		return OIDCLoginExchange{}, false, err
	}
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM oidc_login_exchanges WHERE code_hash = ?`), codeHash)
	if err != nil {
		return OIDCLoginExchange{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return OIDCLoginExchange{}, false, err
	}
	if affected == 0 {
		return OIDCLoginExchange{}, false, nil
	}
	if affected != 1 {
		return OIDCLoginExchange{}, false, fmt.Errorf("consume OIDC login exchange: deleted %d rows", affected)
	}
	if err := tx.Commit(); err != nil {
		return OIDCLoginExchange{}, false, err
	}
	exchange.CreatedAt = parseOptionalTime(createdAt)
	if exchange.CreatedAt.IsZero() || time.Since(exchange.CreatedAt) > 2*time.Minute {
		return OIDCLoginExchange{}, false, nil
	}
	return exchange, true, nil
}
