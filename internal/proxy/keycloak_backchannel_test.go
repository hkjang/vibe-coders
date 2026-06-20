package proxy

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestBackchannelLogoutEventCheck(t *testing.T) {
	good := map[string]any{"events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}}}
	if !backchannelLogoutEvent(good) {
		t.Error("valid back-channel event should be detected")
	}
	if backchannelLogoutEvent(map[string]any{"events": map[string]any{"other": 1}}) {
		t.Error("non-backchannel event must not match")
	}
	if backchannelLogoutEvent(map[string]any{}) {
		t.Error("missing events must not match")
	}
}

func TestKeycloakBackchannelLogoutRevokesSessions(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const issuer = "https://kc.example.com/realms/vibe"
	jwksMu.Lock()
	jwksKeys = map[string]*rsa.PublicKey{"bc-kid": &key.PublicKey}
	jwksFetch = time.Now()
	jwksMu.Unlock()
	discMu.Lock()
	discCache = oidcDiscovery{Issuer: issuer, JWKSURI: "http://unused", AuthorizationEndpoint: "x", TokenEndpoint: "y"}
	discFetch = time.Now()
	discMu.Unlock()

	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	// Seed an identity + an active session for the user.
	if err := db.UpsertAuthIdentity(ctx, store.AuthIdentity{ID: "aid1", UserID: "u-kc", Provider: "keycloak", Issuer: issuer, Subject: "sub-1"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAuthSession(ctx, "sess-1", "u-kc", "ip", "ua", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if active, _ := db.AuthSessionActive(ctx, "sess-1"); !active {
		t.Fatal("session should start active")
	}

	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{Enabled: true, ClientID: "vibe-coders", IssuerURL: issuer}}, db: db}
	logoutToken := signRS256(t, key, "bc-kid", map[string]any{
		"iss": issuer, "aud": "vibe-coders", "sub": "sub-1",
		"events": map[string]any{"http://schemas.openid.net/event/backchannel-logout": map[string]any{}},
		"exp":    float64(time.Now().Add(time.Hour).Unix()),
	})
	form := url.Values{"logout_token": {logoutToken}}
	req := httptest.NewRequest(http.MethodPost, "/auth/keycloak/backchannel-logout", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	s.handleKeycloakBackchannelLogout(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("backchannel logout = %d, want 200", rec.Code)
	}
	if active, _ := db.AuthSessionActive(ctx, "sess-1"); active {
		t.Fatal("session should be revoked after back-channel logout")
	}
}

func TestKeycloakFrontchannelLogoutBySID(t *testing.T) {
	const issuer = "https://kc.example.com/realms/vibe"
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Two sessions for one user; only the one matching the sid should be revoked.
	if err := db.InsertAuthSession(ctx, "sess-A", "u-fc", "ip", "ua", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAuthSession(ctx, "sess-B", "u-fc", "ip", "ua", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.LinkAuthSessionKeycloakSID(ctx, "sess-A", "kc-sid-123"); err != nil {
		t.Fatal(err)
	}

	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{Enabled: true, ClientID: "vibe-coders", IssuerURL: issuer}}, db: db}

	// Wrong issuer → rejected, nothing revoked.
	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/frontchannel-logout?iss=https://evil&sid=kc-sid-123", nil)
	rec := httptest.NewRecorder()
	s.handleKeycloakFrontchannelLogout(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatal("issuer mismatch should not return 200")
	}
	if active, _ := db.AuthSessionActive(ctx, "sess-A"); !active {
		t.Fatal("session must remain active on issuer mismatch")
	}

	// Correct issuer + sid → only sess-A revoked.
	req = httptest.NewRequest(http.MethodGet, "/auth/keycloak/frontchannel-logout?iss="+issuer+"&sid=kc-sid-123", nil)
	rec = httptest.NewRecorder()
	s.handleKeycloakFrontchannelLogout(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("front-channel logout = %d, want 200", rec.Code)
	}
	if active, _ := db.AuthSessionActive(ctx, "sess-A"); active {
		t.Fatal("sess-A (matching sid) should be revoked")
	}
	if active, _ := db.AuthSessionActive(ctx, "sess-B"); !active {
		t.Fatal("sess-B (different sid) should stay active")
	}
}
