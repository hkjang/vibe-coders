package proxy

import (
	"context"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func TestKeycloakConfigDBOverlayAndSecretAtRest(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	cipher, err := secret.New("unit-test-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		cfg: config.Config{Keycloak: config.KeycloakConfig{
			Enabled: false, IssuerURL: "https://env-issuer/realms/x", ClientID: "env-client",
			ClientSecret: "env-secret", DefaultRole: "developer", Scopes: []string{"openid"},
		}},
		db: db,
	}
	s.secrets.Store(cipher)

	// No DB row yet → effective config equals env baseline.
	s.reloadKeycloakConfig(ctx)
	if got := s.keycloakConfig(); got.ClientID != "env-client" || got.ClientSecret != "env-secret" || got.Enabled {
		t.Fatalf("env baseline expected, got %+v", got)
	}

	// Persist a DB override with an encrypted client secret.
	enc, err := cipher.Encrypt("db-top-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveSSOProviderConfig(ctx, store.SSOProviderConfig{
		Provider: "keycloak", Enabled: true, IssuerURL: "https://db-issuer/realms/y",
		ClientID: "db-client", ClientSecretEnc: enc, RedirectURI: "https://gw/cb",
		Scopes: []string{"openid", "profile"}, DefaultRole: "team_admin",
		RoleClaim: "realm_access.roles", GroupClaim: "groups", AllowLocalLogin: false,
		UpdatedBy: "admin@x.com",
	}); err != nil {
		t.Fatal(err)
	}

	// The raw row must NOT contain the plaintext secret.
	rec, found, err := db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil || !found {
		t.Fatalf("get config: found=%v err=%v", found, err)
	}
	if rec.ClientSecretEnc == "db-top-secret" || rec.ClientSecretEnc == "" {
		t.Fatalf("client secret must be stored encrypted, got %q", rec.ClientSecretEnc)
	}

	// After reload, the effective config reflects the DB row with the secret decrypted.
	s.reloadKeycloakConfig(ctx)
	got := s.keycloakConfig()
	if !got.Enabled || got.ClientID != "db-client" || got.IssuerURL != "https://db-issuer/realms/y" {
		t.Fatalf("db overlay not applied: %+v", got)
	}
	if got.ClientSecret != "db-top-secret" {
		t.Fatalf("client secret should decrypt to plaintext, got %q", got.ClientSecret)
	}
	if got.DefaultRole != "team_admin" || got.AllowLocalLogin {
		t.Fatalf("other fields not applied: %+v", got)
	}
}
