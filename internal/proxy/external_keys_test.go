package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func buildAuthServer(t *testing.T, attribute bool) *Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AttributeExternalKeys = attribute
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func reqWithAuth(token string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}"))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestExternalKeyAttributionPerKey(t *testing.T) {
	s := buildAuthServer(t, true)
	ctx := context.Background()

	// a registered (active) proxy key still resolves to its own id
	if err := s.db.UpsertAPIKey(ctx, store.APIKeyRecord{ID: "key_real", Name: "Real", KeyHash: hashProxyKey("real-secret"), Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if id, ok := s.authenticateProxy(reqWithAuth("real-secret", nil)); !ok || id != "key_real" {
		t.Fatalf("registered key should resolve to key_real, got %q ok=%v", id, ok)
	}

	// unregistered per-user keys → distinct, stable ext_ identities
	aliceTok, bobTok := "alice-personal-key", "bob-personal-key"
	wantAlice := "ext_" + hashProxyKey(aliceTok)[:16]
	id, ok := s.authenticateProxy(reqWithAuth(aliceTok, map[string]string{"X-Vibe-User": "alice", "X-Vibe-Team": "platform"}))
	if !ok || id != wantAlice {
		t.Fatalf("alice key should attribute to %q, got %q ok=%v", wantAlice, id, ok)
	}
	idBob, _ := s.authenticateProxy(reqWithAuth(bobTok, nil))
	if idBob == wantAlice {
		t.Fatalf("different keys must not collide: bob=%q alice=%q", idBob, wantAlice)
	}
	// same key again → same identity (stable grouping)
	idAlice2, _ := s.authenticateProxy(reqWithAuth(aliceTok, nil))
	if idAlice2 != wantAlice {
		t.Fatalf("same key should be stable: %q != %q", idAlice2, wantAlice)
	}

	// the labeled external row was registered with the header-supplied name/team
	users, err := s.db.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var alice *store.UserSummary
	for i := range users {
		if users[i].APIKeyID == wantAlice {
			alice = &users[i]
			break
		}
	}
	if alice == nil {
		t.Fatalf("alice external identity %q not found in user list", wantAlice)
	}
	if alice.Name != "alice" || alice.Team != "platform" || alice.Status != "external" {
		t.Fatalf("unexpected external user: name=%q team=%q status=%q", alice.Name, alice.Team, alice.Status)
	}
}

func TestExternalKeyAttributionDisabledFallsBackToPassthrough(t *testing.T) {
	s := buildAuthServer(t, false)
	id, ok := s.authenticateProxy(reqWithAuth("some-upstream-key", nil))
	if !ok || id != "passthrough" {
		t.Fatalf("with attribution disabled expected passthrough, got %q ok=%v", id, ok)
	}
}

// TestPromoteExternalKey verifies an observed external key (hash already stored)
// can be promoted to a named, active managed user via PATCH — without the
// plaintext — and that the client's key then authenticates to that identity.
func TestPromoteExternalKey(t *testing.T) {
	s := buildAuthServer(t, true)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	hash := hashProxyKey("qwen-real-key")
	extID := "ext_" + hash[:16]
	if err := s.db.EnsureExternalAPIKey(ctx, store.APIKeyRecord{ID: extID, Name: "external-" + hash[:8], KeyHash: hash, Status: "external"}); err != nil {
		t.Fatal(err)
	}
	// not yet an active (registered) key
	if _, found, _ := s.db.FindActiveAPIKeyByHash(ctx, hash); found {
		t.Fatal("external key should not authenticate as active before promotion")
	}

	req, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/api-keys/"+extID, strings.NewReader(`{"status":"active","name":"qwenpaw","team":"coders"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("promote PATCH failed: %d", resp.StatusCode)
	}

	rec, found, err := s.db.GetAPIKey(ctx, extID)
	if err != nil || !found {
		t.Fatalf("get after promote: found=%v err=%v", found, err)
	}
	if rec.Status != "active" || rec.Name != "qwenpaw" || rec.Team != "coders" {
		t.Fatalf("unexpected promoted row: %+v", rec)
	}
	if rec.KeyHash != hash {
		t.Fatalf("key hash must be preserved on promote: %q != %q", rec.KeyHash, hash)
	}
	// the client's key now authenticates to the promoted identity
	k, found, _ := s.db.FindActiveAPIKeyByHash(ctx, hash)
	if !found || k.ID != extID {
		t.Fatalf("promoted key should authenticate to %q, got found=%v id=%q", extID, found, k.ID)
	}
	if id, ok := s.authenticateProxy(reqWithAuth("qwen-real-key", nil)); !ok || id != extID {
		t.Fatalf("client key should attribute to %q, got %q ok=%v", extID, id, ok)
	}
}
