package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func meKeysServer(t *testing.T, selfService bool) (*httptest.Server, *store.SQLStore) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(upstream.Close)

	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	cfg := testConfig(upstream.URL, "secret")
	cfg.Auth.SelfServiceKeys = selfService
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Seed a primary key for user u1 (developer scopes) — its plaintext is "usersecret".
	if err := db.UpsertAPIKey(context.Background(), store.APIKeyRecord{
		ID: "key_primary_u1", Name: "u1 primary", KeyHash: hashProxyKey("usersecret"),
		UserID: "u1", Team: "t1", Role: "developer", Status: "active",
		Scopes: []string{"chat:completion", "models:read"},
	}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts, db
}

func TestSelfServiceKeysDisabled(t *testing.T) {
	ts, _ := meKeysServer(t, false)
	resp := postJSON(t, ts.URL+"/me/keys", "usersecret", map[string]any{"name": "cli"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled self-service should 404, got %d", resp.StatusCode)
	}
}

func TestSelfServiceKeysLifecycle(t *testing.T) {
	ts, _ := meKeysServer(t, true)

	// Create: inherits caller scopes when none requested.
	resp := postJSON(t, ts.URL+"/me/keys", "usersecret", map[string]any{"name": "cli key"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create should 201, got %d", resp.StatusCode)
	}
	var created struct {
		APIKey struct {
			ID     string   `json:"id"`
			UserID string   `json:"user_id"`
			Role   string   `json:"role"`
			Scopes []string `json:"scopes"`
		} `json:"api_key"`
		Secret string `json:"secret"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.Secret == "" || created.APIKey.UserID != "u1" || created.APIKey.Role != "developer" {
		t.Fatalf("unexpected created key: %+v", created.APIKey)
	}
	if len(created.APIKey.Scopes) != 2 {
		t.Errorf("new key should inherit caller's 2 scopes, got %v", created.APIKey.Scopes)
	}

	// Narrowing to a valid subset of the caller's scopes is allowed (role-appropriate).
	sub := postJSON(t, ts.URL+"/me/keys", "usersecret", map[string]any{"name": "narrow", "scopes": []string{"models:read"}})
	var narrowed struct {
		APIKey struct {
			Scopes []string `json:"scopes"`
		} `json:"api_key"`
	}
	json.NewDecoder(sub.Body).Decode(&narrowed)
	sub.Body.Close()
	if sub.StatusCode != http.StatusCreated || len(narrowed.APIKey.Scopes) != 1 || narrowed.APIKey.Scopes[0] != "models:read" {
		t.Fatalf("narrowing to a subset should 201 with that scope, got status %d %+v", sub.StatusCode, narrowed.APIKey.Scopes)
	}

	// Scope escalation is denied.
	esc := postJSON(t, ts.URL+"/me/keys", "usersecret", map[string]any{"name": "evil", "scopes": []string{"admin:write"}})
	defer esc.Body.Close()
	if esc.StatusCode != http.StatusForbidden {
		t.Fatalf("scope escalation should 403, got %d", esc.StatusCode)
	}

	// List: returns the caller's own keys, plus the caller's role and grantable scopes for the picker.
	listReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/me/keys", nil)
	listReq.Header.Set("Authorization", "Bearer usersecret")
	listResp, err := http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		APIKeys         []store.APIKeyPublic `json:"api_keys"`
		Role            string               `json:"role"`
		GrantableScopes []string             `json:"grantable_scopes"`
	}
	json.NewDecoder(listResp.Body).Decode(&listed)
	listResp.Body.Close()
	if listed.Role != "developer" {
		t.Errorf("expected role developer in list response, got %q", listed.Role)
	}
	if len(listed.GrantableScopes) != 2 {
		t.Errorf("expected 2 grantable scopes, got %v", listed.GrantableScopes)
	}
	// 3 own keys now: primary + created + narrowed.
	if len(listed.APIKeys) != 3 {
		t.Errorf("expected 3 own keys, got %d", len(listed.APIKeys))
	}
	for _, k := range listed.APIKeys {
		if k.UserID != "u1" {
			t.Errorf("listed a key not owned by caller: %+v", k)
		}
	}

	// PATCH scopes of an existing key to a valid subset → 200.
	patchOK := patchJSON(t, ts.URL+"/me/keys/"+created.APIKey.ID, "usersecret", map[string]any{"scopes": []string{"models:read"}})
	patchOK.Body.Close()
	if patchOK.StatusCode != http.StatusOK {
		t.Fatalf("scope edit to subset should 200, got %d", patchOK.StatusCode)
	}
	// PATCH with an escalated scope → 403.
	patchBad := patchJSON(t, ts.URL+"/me/keys/"+created.APIKey.ID, "usersecret", map[string]any{"scopes": []string{"admin:write"}})
	patchBad.Body.Close()
	if patchBad.StatusCode != http.StatusForbidden {
		t.Fatalf("scope edit escalation should 403, got %d", patchBad.StatusCode)
	}

	// Rotate the created key → new secret, old revoked.
	rot := postJSON(t, ts.URL+"/me/keys/"+created.APIKey.ID+"/rotate", "usersecret", map[string]any{})
	var rotated struct {
		RotatedFrom string `json:"rotated_from"`
		Secret      string `json:"secret"`
		APIKey      struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	json.NewDecoder(rot.Body).Decode(&rotated)
	rot.Body.Close()
	if rot.StatusCode != http.StatusOK || rotated.Secret == "" || rotated.APIKey.ID == created.APIKey.ID {
		t.Fatalf("rotate should return a new key+secret, got status %d %+v", rot.StatusCode, rotated)
	}

	// Revoking a key not owned by the caller → 404 (ownership hidden).
	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/me/keys/key_does_not_exist", nil)
	delReq.Header.Set("Authorization", "Bearer usersecret")
	delResp, _ := http.DefaultClient.Do(delReq)
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNotFound {
		t.Errorf("revoking unknown key should 404, got %d", delResp.StatusCode)
	}
}
