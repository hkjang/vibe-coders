package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// AuthIdentity links an external SSO identity (provider + issuer + subject) to an internal
// user, so repeat logins resolve to the same account.
type AuthIdentity struct {
	ID                string `json:"id"`
	UserID            string `json:"user_id"`
	Provider          string `json:"provider"`
	Issuer            string `json:"issuer"`
	Subject           string `json:"subject"`
	Email             string `json:"email"`
	PreferredUsername string `json:"preferred_username"`
	CreatedAt         string `json:"created_at"`
	LastLoginAt       string `json:"last_login_at"`
}

// AuthIdentityBySubject finds the internal linkage for an external (provider,issuer,subject).
func (s *SQLStore) AuthIdentityBySubject(ctx context.Context, provider, issuer, subject string) (AuthIdentity, bool, error) {
	var a AuthIdentity
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, user_id, provider, issuer, subject, email, preferred_username, created_at, COALESCE(last_login_at,'')
		FROM auth_identities WHERE provider = ? AND issuer = ? AND subject = ?`), provider, issuer, subject).
		Scan(&a.ID, &a.UserID, &a.Provider, &a.Issuer, &a.Subject, &a.Email, &a.PreferredUsername, &a.CreatedAt, &a.LastLoginAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthIdentity{}, false, nil
	}
	if err != nil {
		return AuthIdentity{}, false, err
	}
	return a, true, nil
}

// UpsertAuthIdentity inserts or updates an identity by (provider,issuer,subject), refreshing
// email/username/last_login and preserving created_at + user_id.
func (s *SQLStore) UpsertAuthIdentity(ctx context.Context, a AuthIdentity) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if a.CreatedAt == "" {
		a.CreatedAt = now
	}
	if a.LastLoginAt == "" {
		a.LastLoginAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO auth_identities
		(id, user_id, provider, issuer, subject, email, preferred_username, created_at, last_login_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, issuer, subject) DO UPDATE SET
			email = excluded.email, preferred_username = excluded.preferred_username, last_login_at = excluded.last_login_at`),
		a.ID, a.UserID, a.Provider, a.Issuer, a.Subject, a.Email, a.PreferredUsername, a.CreatedAt, a.LastLoginAt)
	return err
}
