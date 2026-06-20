package proxy

import (
	"context"

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

// reloadKeycloakConfig rebuilds the effective Keycloak overlay from the DB row (if any),
// decrypting the stored client secret, and falls back to environment config otherwise. Safe to
// call at startup and after an admin saves the SSO settings.
func (s *Server) reloadKeycloakConfig(ctx context.Context) {
	eff := s.cfg.Keycloak // env baseline
	if rec, found, err := s.db.GetSSOProviderConfig(ctx, "keycloak"); err == nil && found {
		eff.Enabled = rec.Enabled
		eff.IssuerURL = rec.IssuerURL
		eff.ClientID = rec.ClientID
		eff.RedirectURI = rec.RedirectURI
		eff.DefaultRole = rec.DefaultRole
		eff.RoleClaim = rec.RoleClaim
		eff.GroupClaim = rec.GroupClaim
		eff.AllowLocalLogin = rec.AllowLocalLogin
		if len(rec.Scopes) > 0 {
			eff.Scopes = rec.Scopes
		}
		// Decrypt the client secret; if decryption fails, keep the env value rather than
		// blanking it (prevents a key mismatch from silently breaking confidential clients).
		if rec.ClientSecretEnc != "" {
			if plain, derr := s.secrets.Load().Decrypt(rec.ClientSecretEnc); derr == nil {
				eff.ClientSecret = plain
			}
		} else {
			eff.ClientSecret = ""
		}
	}
	s.keycloakCfg.Store(&eff)
}

// storedKeycloakConfig returns the raw DB override row for the admin screen (no plaintext
// secret). The bool reports whether a DB row exists (vs. pure env config).
func (s *Server) storedKeycloakConfig(ctx context.Context) (store.SSOProviderConfig, bool) {
	rec, found, err := s.db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil {
		return store.SSOProviderConfig{}, false
	}
	return rec, found
}
