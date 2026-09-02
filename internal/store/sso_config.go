package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrSSOConfigConflict = errors.New("SSO provider config changed concurrently")

// SSOProviderConfig is a DB-backed override for an SSO provider's settings (e.g. Keycloak).
// When a row exists, it takes precedence over environment defaults at runtime. The client
// secret is stored encrypted (ClientSecretEnc holds the AES-GCM ciphertext, never plaintext).
type SSOProviderConfig struct {
	Provider        string            `json:"provider"`
	Enabled         bool              `json:"enabled"`
	IssuerURL       string            `json:"issuer_url"`
	ClientID        string            `json:"client_id"`
	ClientSecretEnc string            `json:"-"` // ciphertext; never serialized to clients
	RedirectURI     string            `json:"redirect_uri"`
	Scopes          []string          `json:"scopes"`
	DefaultRole     string            `json:"default_role"`
	RoleClaim       string            `json:"role_claim"`
	GroupClaim      string            `json:"group_claim"`
	AllowLocalLogin bool              `json:"allow_local_login"`
	RoleMap         map[string]string `json:"role_map"` // Keycloak role → internal role (overrides defaults)
	UpdatedAt       string            `json:"updated_at"`
	UpdatedBy       string            `json:"updated_by"`
	Version         int               `json:"version"`
}

// GetSSOProviderConfig returns the stored override for a provider, if any.
func (s *SQLStore) GetSSOProviderConfig(ctx context.Context, provider string) (SSOProviderConfig, bool, error) {
	var (
		c        SSOProviderConfig
		enabled  int
		allow    int
		scopes   string
		roleMapJ string
	)
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT provider, enabled, issuer_url, client_id, client_secret_enc,
		redirect_uri, scopes, default_role, role_claim, group_claim, allow_local_login, COALESCE(role_map,''), updated_at, updated_by, version
		FROM sso_provider_config WHERE provider = ?`), provider).
		Scan(&c.Provider, &enabled, &c.IssuerURL, &c.ClientID, &c.ClientSecretEnc, &c.RedirectURI,
			&scopes, &c.DefaultRole, &c.RoleClaim, &c.GroupClaim, &allow, &roleMapJ, &c.UpdatedAt, &c.UpdatedBy, &c.Version)
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
	if strings.TrimSpace(roleMapJ) != "" {
		if err := json.Unmarshal([]byte(roleMapJ), &c.RoleMap); err != nil {
			return SSOProviderConfig{}, false, fmt.Errorf("decode SSO role map: %w", err)
		}
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
	roleMapJ := ""
	if len(c.RoleMap) > 0 {
		if b, err := json.Marshal(c.RoleMap); err == nil {
			roleMapJ = string(b)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldVersion int
	found := true
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT version FROM sso_provider_config WHERE provider = ?`), c.Provider).Scan(&oldVersion); errors.Is(err, sql.ErrNoRows) {
		found = false
		oldVersion = 0
	} else if err != nil {
		return err
	}
	// Version zero is valid only for the first insert. Existing rows always require the
	// caller's observed version so a forgotten CAS token cannot silently bypass safety.
	if c.Version != oldVersion {
		return fmt.Errorf("%w: expected version %d, current version %d", ErrSSOConfigConflict, c.Version, oldVersion)
	}
	c.Version = oldVersion + 1
	var result sql.Result
	if !found {
		result, err = tx.ExecContext(ctx, s.bind(`INSERT INTO sso_provider_config
		(provider, enabled, issuer_url, client_id, client_secret_enc, redirect_uri, scopes,
		 default_role, role_claim, group_claim, allow_local_login, role_map, updated_at, updated_by, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO NOTHING`),
			c.Provider, enabled, c.IssuerURL, c.ClientID, c.ClientSecretEnc, c.RedirectURI,
			strings.Join(c.Scopes, " "), c.DefaultRole, c.RoleClaim, c.GroupClaim, allow, roleMapJ, c.UpdatedAt, c.UpdatedBy, c.Version)
	} else {
		result, err = tx.ExecContext(ctx, s.bind(`UPDATE sso_provider_config SET
			enabled = ?, issuer_url = ?, client_id = ?, client_secret_enc = ?, redirect_uri = ?,
			scopes = ?, default_role = ?, role_claim = ?, group_claim = ?, allow_local_login = ?,
			role_map = ?, updated_at = ?, updated_by = ?, version = ?
			WHERE provider = ? AND version = ?`),
			enabled, c.IssuerURL, c.ClientID, c.ClientSecretEnc, c.RedirectURI,
			strings.Join(c.Scopes, " "), c.DefaultRole, c.RoleClaim, c.GroupClaim, allow,
			roleMapJ, c.UpdatedAt, c.UpdatedBy, c.Version, c.Provider, oldVersion)
	}
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrSSOConfigConflict
	}
	return tx.Commit()
}
