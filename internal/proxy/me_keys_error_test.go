package proxy

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestSelfServiceKeyReadErrorsDoNotExposeDatabaseDetails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key-errors.db")
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal("store fixture failed")
	}
	defer db.Close()
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("migration fixture failed")
	}
	cfg := testConfig("http://example.invalid", "synthetic")
	cfg.Auth.Enabled, cfg.Auth.SelfServiceKeys = true, true
	cfg.Auth.JWTSecret = "synthetic-test-signing-value"
	s := &Server{cfg: cfg, db: db}
	now := time.Now()
	if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: "fixture-user", Email: "fixture@example.invalid", Name: "fixture", Role: "developer", Status: "active"}); err != nil {
		t.Fatal("user fixture failed")
	}
	if err := db.InsertAuthSession(t.Context(), "fixture-session", "fixture-user", "", "", now.Add(time.Hour)); err != nil {
		t.Fatal("session fixture failed")
	}
	token, err := s.signAccessToken(accessClaims{Subject: "fixture-user", SessionID: "fixture-session", Role: "developer", Type: "access", ExpiresAt: now.Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal("token fixture failed")
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal("raw fixture failed")
	}
	defer raw.Close()
	// Authentication remains available; only personal key queries fail.
	if _, err := raw.ExecContext(t.Context(), `ALTER TABLE api_keys RENAME TO unavailable_keys`); err != nil {
		t.Fatal("failure fixture failed")
	}
	for _, tc := range []struct{ path, message, code string }{
		{"/me/keys", "could not load personal keys", "keys_failed"},
		{"/me/keys/fixture/rotate", "could not load personal key", "key_lookup_failed"},
	} {
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		if tc.path == "/me/keys" {
			s.handleMyKeys(w, r)
		} else {
			s.handleMyKeyByID(w, r)
		}
		var body struct {
			Error struct{ Message, Code string } `json:"error"`
		}
		if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != http.StatusInternalServerError || body.Error.Message != tc.message || body.Error.Code != tc.code {
			t.Fatal("personal key error was not the fixed public response")
		}
	}
}
