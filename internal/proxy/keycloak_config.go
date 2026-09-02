package proxy

import (
	"context"
	"fmt"
	"strings"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// keycloakConfig returns the effective Keycloak configuration: the DB-backed provider overlay
// when one has been loaded, otherwise the environment defaults from cfg.Keycloak. The returned
// value already has its client secret decrypted.
func (s *Server) keycloakConfig() config.KeycloakConfig {
	if c := s.keycloakCfg.Load(); c != nil {
		return *c
	}
	return s.cfg.Keycloak
}

// loadKeycloakConfig builds one complete configuration from a single source. A DB-backed
// record never borrows a secret (or another field) from the environment: mixing credentials
// across issuers can disclose a client secret to the wrong token endpoint.
func (s *Server) loadKeycloakConfig(ctx context.Context) (config.KeycloakConfig, error) {
	rec, found, err := s.db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil {
		return config.KeycloakConfig{}, fmt.Errorf("load Keycloak config: %w", err)
	}
	if !found {
		eff := s.cfg.Keycloak
		if !s.cfg.Auth.Enabled {
			eff.Enabled = false
		}
		return eff, nil
	}

	eff := config.KeycloakConfig{
		Enabled:         rec.Enabled,
		IssuerURL:       strings.TrimRight(rec.IssuerURL, "/"),
		ClientID:        rec.ClientID,
		RedirectURI:     rec.RedirectURI,
		Scopes:          append([]string{}, rec.Scopes...),
		DefaultRole:     rec.DefaultRole,
		RoleClaim:       rec.RoleClaim,
		GroupClaim:      rec.GroupClaim,
		AllowLocalLogin: rec.AllowLocalLogin,
		RoleMap:         rec.RoleMap,
	}
	if len(eff.Scopes) == 0 {
		eff.Scopes = []string{"openid", "profile", "email"}
	}
	if eff.DefaultRole == "" {
		eff.DefaultRole = "developer"
	}
	if eff.RoleClaim == "" {
		eff.RoleClaim = "realm_access.roles"
	}
	if eff.GroupClaim == "" {
		eff.GroupClaim = "groups"
	}
	if rec.ClientSecretEnc != "" {
		plain, err := s.secrets.Load().Decrypt(rec.ClientSecretEnc)
		if err != nil {
			return config.KeycloakConfig{}, fmt.Errorf("decrypt Keycloak client secret: %w", err)
		}
		eff.ClientSecret = plain
	}
	if !s.cfg.Auth.Enabled {
		eff.Enabled = false
	}
	return eff, nil
}

// reloadKeycloakConfig atomically publishes a fully validated snapshot. On a transient DB or
// decryption failure it retains the last-known-good value; before the first successful load it
// publishes an SSO-disabled snapshot so startup fails closed without mixing credential sources.
func (s *Server) reloadKeycloakConfig(ctx context.Context) error {
	eff, err := s.loadKeycloakConfig(ctx)
	if err != nil {
		if s.keycloakCfg.Load() == nil {
			safe := s.cfg.Keycloak
			safe.Enabled = false
			safe.ClientSecret = ""
			s.keycloakCfg.Store(&safe)
		}
		return err
	}
	if previous := s.keycloakCfg.Load(); previous != nil &&
		(previous.IssuerURL != eff.IssuerURL || previous.ClientID != eff.ClientID || previous.Enabled != eff.Enabled) {
		invalidateOIDCCaches()
	}
	s.keycloakCfg.Store(&eff)
	return nil
}

// effectiveKeycloakRoleMap returns the admin-edited Keycloak→internal role map when present,
// otherwise the built-in default (keycloakRoleMap).
func (s *Server) effectiveKeycloakRoleMap() map[string]string {
	if m := s.keycloakConfig().RoleMap; len(m) > 0 {
		return m
	}
	return keycloakRoleMap
}

// storedKeycloakConfig returns the raw DB override row for the admin screen (no plaintext
// secret). The bool reports whether a DB row exists (vs. pure env config).
func (s *Server) storedKeycloakConfig(ctx context.Context) (store.SSOProviderConfig, bool, error) {
	rec, found, err := s.db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil {
		return store.SSOProviderConfig{}, false, err
	}
	return rec, found, nil
}
