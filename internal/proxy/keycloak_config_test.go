package proxy

import (
	"context"
	"testing"
	"time"

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
		cfg: config.Config{
			Auth: config.AuthConfig{Enabled: true, JWTSecret: "test-jwt-secret"},
			Keycloak: config.KeycloakConfig{
				Enabled: false, IssuerURL: "https://env-issuer/realms/x", ClientID: "env-client",
				ClientSecret: "env-secret", DefaultRole: "developer", Scopes: []string{"openid"},
			},
		},
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

	wrongCipher, err := secret.New("different-unit-test-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	s.secrets.Store(wrongCipher)
	if err := s.reloadKeycloakConfig(ctx); err == nil {
		t.Fatal("decrypting the DB config with the wrong key must fail")
	}
	retained := s.keycloakConfig()
	if retained.IssuerURL != got.IssuerURL || retained.ClientID != got.ClientID || retained.ClientSecret != got.ClientSecret || retained.AllowLocalLogin != got.AllowLocalLogin {
		t.Fatalf("failed reload replaced the last-known-good config: got %+v want %+v", retained, got)
	}
}

func TestKeycloakConfigConvergesThroughRuntimeReloadLoop(t *testing.T) {
	db := openTestStore(t)
	ctx := context.Background()

	cipher, err := secret.New("unit-test-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	pod := &Server{
		cfg: config.Config{
			Auth: config.AuthConfig{Enabled: true, JWTSecret: "test-jwt-secret"},
			Keycloak: config.KeycloakConfig{
				IssuerURL: "https://env-issuer/realms/x",
				ClientID:  "env-client",
			},
		},
		db: db,
	}
	pod.secrets.Store(cipher)
	// Model startup: runtime config and Keycloak are loaded before the polling goroutine starts.
	pod.reloadRuntimeConfig(ctx)
	pod.reloadText2SQLFeatures(ctx)
	pod.reloadKeycloakConfig(ctx)

	enc, err := cipher.Encrypt("db-top-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveSSOProviderConfig(ctx, store.SSOProviderConfig{
		Provider: "keycloak", Enabled: true, IssuerURL: "https://db-issuer/realms/y",
		ClientID: "db-client", ClientSecretEnc: enc, RedirectURI: "https://gw.example/auth/keycloak/callback", Scopes: []string{"openid"},
		AllowLocalLogin: false, UpdatedBy: "admin@x.com",
	}); err != nil {
		t.Fatal(err)
	}

	loopCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		pod.runtimeReloadLoop(loopCtx, 5*time.Millisecond)
	}()
	waitFor(t, time.Second, func() bool {
		got := pod.keycloakConfig()
		return got.Enabled && got.ClientID == "db-client" && got.ClientSecret == "db-top-secret"
	})
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runtime reload loop did not stop")
	}
}

func TestResolveKeycloakRoleWithCustomMap(t *testing.T) {
	// Empty/nil map falls back to the built-in defaults.
	if got := resolveKeycloakRoleWith(nil, []string{"vibe-admin"}, "developer"); got != "admin" {
		t.Errorf("nil map should use defaults, got %q", got)
	}
	// A custom map overrides the defaults (here vibe-admin is downgraded; a custom role wins).
	custom := map[string]string{"sso-superuser": "admin", "vibe-admin": "developer"}
	if got := resolveKeycloakRoleWith(custom, []string{"sso-superuser", "vibe-admin"}, "developer"); got != "admin" {
		t.Errorf("custom map: highest-rank mapped role should win, got %q", got)
	}
	// A role only present in the default map is unknown under a custom map → default role.
	if got := resolveKeycloakRoleWith(custom, []string{"vibe-auditor"}, "developer"); got != "developer" {
		t.Errorf("unmapped role should fall back to default, got %q", got)
	}
}

func TestEffectiveKeycloakRoleMap(t *testing.T) {
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{}}}
	// No overlay → built-in defaults.
	if s.effectiveKeycloakRoleMap()["vibe-admin"] != "admin" {
		t.Error("default map expected without overlay")
	}
	// Overlay with a custom map → custom map returned.
	s.keycloakCfg.Store(&config.KeycloakConfig{RoleMap: map[string]string{"x": "team_admin"}})
	m := s.effectiveKeycloakRoleMap()
	if m["x"] != "team_admin" || len(m) != 1 {
		t.Errorf("custom overlay map expected, got %v", m)
	}
}
