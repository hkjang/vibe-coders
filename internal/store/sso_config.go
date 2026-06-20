package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// SSOProviderConfig is a DB-backed override for an SSO provider's settings (e.g. Keycloak).
// When a row exists, it takes precedence over environment defaults at runtime. The client
// secret is stored encrypted (ClientSecretEnc holds the AES-GCM ciphertext, never plaintext).
type SSOProviderConfig struct {
	Provider        string   `json:"provider"`
	Enabled         bool     `json:"enabled"`
	IssuerURL       string   `json:"issuer_url"`
	ClientID        string   `json:"client_id"`
	ClientSecretEnc string   `json:"-"` // ciphertext; never serialized to clients
	RedirectURI     string   `json:"redirect_uri"`
	Scopes          []string `json:"scopes"`
	DefaultRole     string   `json:"default_role"`
	RoleClaim       string   `json:"role_claim"`
	GroupClaim      string   `json:"group_claim"`
	AllowLocalLogin bool     `json:"allow_local_login"`
	UpdatedAt       string   `json:"updated_at"`
	UpdatedBy       string   `json:"updated_by"`
}

// GetSSOProviderConfig returns the stored override for a provider, if any.
func (s *SQLStore) GetSSOProviderConfig(ctx context.Context, provider string) (SSOProviderConfig, bool, error) {
	var (
		c       SSOProviderConfig
		enabled int
		allow   int
		scopes  string
	)
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT provider, enabled, issuer_url, client_id, client_secret_enc,
		redirect_uri, scopes, default_role, role_claim, group_claim, allow_local_login, updated_at, updated_by
		FROM sso_provider_config WHERE provider = ?`), provider).
		Scan(&c.Provider, &enabled, &c.IssuerURL, &c.ClientID, &c.ClientSecretEnc, &c.RedirectURI,
			&scopes, &c.DefaultRole, &c.RoleClaim, &c.GroupClaim, &allow, &c.UpdatedAt, &c.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return SSOProviderConfig{}, false, nil
	}
	if err != nil {
		return SSOProviderConfig{}, false, err
	}
	c.Enabled = enabled != 0
	c.AllowLocalLogin = allow != 0
	if strings.TrimSpace(scopes) != "" {
		c.Scopes = strings.Fields(scopes)
	}
	return c, true, nil
}

// SaveSSOProviderConfig upserts a provider override. The caller is responsible for encrypting
// the client secret into ClientSecretEnc before calling.
func (s *SQLStore) SaveSSOProviderConfig(ctx context.Context, c SSOProviderConfig) error {
	if c.Provider == "" {
		return errors.New("provider is required")
	}
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	enabled, allow := 0, 0
	if c.Enabled {
		enabled = 1
	}
	if c.AllowLocalLogin {
		allow = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO sso_provider_config
		(provider, enabled, issuer_url, client_id, client_secret_enc, redirect_uri, scopes,
		 default_role, role_claim, group_claim, allow_local_login, updated_at, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider) DO UPDATE SET
			enabled = excluded.enabled, issuer_url = excluded.issuer_url, client_id = excluded.client_id,
			client_secret_enc = excluded.client_secret_enc, redirect_uri = excluded.redirect_uri,
			scopes = excluded.scopes, default_role = excluded.default_role, role_claim = excluded.role_claim,
			group_claim = excluded.group_claim, allow_local_login = excluded.allow_local_login,
			updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
		c.Provider, enabled, c.IssuerURL, c.ClientID, c.ClientSecretEnc, c.RedirectURI,
		strings.Join(c.Scopes, " "), c.DefaultRole, c.RoleClaim, c.GroupClaim, allow, c.UpdatedAt, c.UpdatedBy)
	return err
}
