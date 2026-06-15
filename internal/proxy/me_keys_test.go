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

	// Scope escalation is denied.
	esc := postJSON(t, ts.URL+"/me/keys", "usersecret", map[string]any{"name": "evil", "scopes": []string{"admin:write"}})
	defer esc.Body.Close()
	if esc.StatusCode != http.StatusForbidden {
		t.Fatalf("scope escalation should 403, got %d", esc.StatusCode)
	}

	// List: returns the caller's own keys (primary + created), not others.
	listReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/me/keys", nil)
	listReq.Header.Set("Authorization", "Bearer usersecret")
	listResp, err := http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		APIKeys []store.APIKeyPublic `json:"api_keys"`
	}
	json.NewDecoder(listResp.Body).Decode(&listed)
	listResp.Body.Close()
	if len(listed.APIKeys) != 2 {
		t.Errorf("expected 2 own keys, got %d", len(listed.APIKeys))
	}
	for _, k := range listed.APIKeys {
		if k.UserID != "u1" {
			t.Errorf("listed a key not owned by caller: %+v", k)
		}
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
