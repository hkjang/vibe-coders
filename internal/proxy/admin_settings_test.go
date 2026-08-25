package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func settingsServer(t *testing.T) (*httptest.Server, *store.SQLStore) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	t.Cleanup(upstream.Close)
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts, db
}

func req(t *testing.T, method, url, body string) (*http.Response, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
	}
	r, _ := http.NewRequest(method, url, rdr)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	_ = json.Unmarshal(b, &out)
	return resp, out
}

func TestAdminSettingsLifecycle(t *testing.T) {
	ts, db := settingsServer(t)
	base := ts.URL + "/admin/settings"

	// PUT a non-secret value.
	resp, _ := req(t, http.MethodPut, base+"/by-key/text2sql.default_limit", `{"value":"50","reason":"tune"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT default_limit = %d", resp.StatusCode)
	}
	// GET shows admin source + new value.
	_, list := req(t, http.MethodGet, base+"/text2sql.safety", "")
	settings, _ := list["settings"].([]any)
	found := false
	for _, it := range settings {
		m := it.(map[string]any)
		if m["key"] == "text2sql.default_limit" {
			found = true
			if m["source"] != "admin" || m["value"] != "50" {
				t.Errorf("default_limit view = %+v, want admin/50", m)
			}
		}
	}
	if !found {
		t.Fatal("default_limit not in text2sql.safety category listing")
	}

	// Secret: PUT exec_dsn → masked in view, encrypted at rest.
	resp, _ = req(t, http.MethodPut, base+"/by-key/text2sql.exec_dsn", `{"value":"postgres://u:p@host/db"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT exec_dsn = %d", resp.StatusCode)
	}
	stored, ok, err := db.GetAdminSetting(context.Background(), "text2sql.exec_dsn")
	if err != nil || !ok {
		t.Fatal("exec_dsn not stored")
	}
	if strings.Contains(stored.ValueJSON, "postgres://") {
		t.Error("secret stored in plaintext")
	}
	_, dsnView := req(t, http.MethodGet, base+"/text2sql", "")
	for _, it := range dsnView["settings"].([]any) {
		m := it.(map[string]any)
		if m["key"] == "text2sql.exec_dsn" {
			if m["value"] != "********" || m["is_set"] != true {
				t.Errorf("secret view = %+v, want masked + is_set", m)
			}
		}
	}

	// Validate: out-of-range sample rate rejected, in-range accepted.
	_, v1 := req(t, http.MethodPost, base+"/validate", `{"key":"text2sql.shadow_sample_rate","value":"2"}`)
	if v1["ok"] != false {
		t.Errorf("sample_rate 2 should be invalid, got %+v", v1)
	}
	_, v2 := req(t, http.MethodPost, base+"/validate", `{"key":"text2sql.shadow_sample_rate","value":"0.5"}`)
	if v2["ok"] != true {
		t.Errorf("sample_rate 0.5 should be valid, got %+v", v2)
	}
	// Cross-key: default_limit > max_limit invalid (max defaults to 0 in test config).
	_, v3 := req(t, http.MethodPost, base+"/validate", `{"key":"text2sql.default_limit","value":"999"}`)
	if v3["ok"] != false {
		t.Errorf("default_limit 999 > max should be invalid, got %+v", v3)
	}

	// Rollback: change again, then roll back to 50.
	req(t, http.MethodPut, base+"/by-key/text2sql.default_limit", `{"value":"70"}`)
	resp, rb := req(t, http.MethodPost, base+"/rollback", `{"key":"text2sql.default_limit","reason":"oops"}`)
	if resp.StatusCode != http.StatusOK || rb["value"] != "50" {
		t.Errorf("rollback should restore 50, got status %d %+v", resp.StatusCode, rb)
	}

	// Secret rollback is rejected.
	resp, _ = req(t, http.MethodPost, base+"/rollback", `{"key":"text2sql.exec_dsn"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("secret rollback should 400, got %d", resp.StatusCode)
	}

	// History present.
	_, h := req(t, http.MethodGet, base+"/history?key=text2sql.default_limit", "")
	if hist, _ := h["history"].([]any); len(hist) < 2 {
		t.Errorf("expected >=2 history rows, got %d", len(h["history"].([]any)))
	}

	// DELETE reverts to env source.
	req(t, http.MethodDelete, base+"/by-key/text2sql.default_limit", "")
	_, after := req(t, http.MethodGet, base+"/text2sql.safety", "")
	for _, it := range after["settings"].([]any) {
		m := it.(map[string]any)
		if m["key"] == "text2sql.default_limit" && m["source"] != "env" {
			t.Errorf("after delete source = %v, want env", m["source"])
		}
	}
}

func TestAdminSettingsEffectiveLayers(t *testing.T) {
	ts, _ := settingsServer(t)
	base := ts.URL + "/admin/settings"

	resp, _ := req(t, http.MethodPut, base+"/by-key/text2sql.default_limit", `{"value":"50","reason":"layer test"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT default_limit = %d", resp.StatusCode)
	}
	resp, _ = req(t, http.MethodPut, base+"/by-key/text2sql.exec_dsn", `{"value":"postgres://user:pass@example/db","reason":"secret layer test"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT exec_dsn = %d", resp.StatusCode)
	}

	resp, out := req(t, http.MethodGet, base+"/effective?category=text2sql", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET effective = %d %+v", resp.StatusCode, out)
	}
	if order, _ := out["resolution_order"].([]any); len(order) != 4 || order[0] != "request_override" || order[3] != "bootstrap_env" {
		t.Fatalf("unexpected resolution_order: %+v", out["resolution_order"])
	}
	settings, _ := out["settings"].([]any)
	var defLimit, execDSN map[string]any
	for _, it := range settings {
		m := it.(map[string]any)
		switch m["key"] {
		case "text2sql.default_limit":
			defLimit = m
		case "text2sql.exec_dsn":
			execDSN = m
		}
	}
	if defLimit == nil {
		t.Fatal("text2sql.default_limit missing from effective settings")
	}
	if defLimit["effective_source"] != "db_setting" || defLimit["value"] != "50" || defLimit["source"] != "admin" {
		t.Fatalf("default_limit effective view mismatch: %+v", defLimit)
	}
	foundActiveDB := false
	for _, l := range defLimit["layers"].([]any) {
		layer := l.(map[string]any)
		if layer["name"] == "db_setting" {
			foundActiveDB = layer["configured"] == true && layer["active"] == true && layer["value"] == "50"
		}
	}
	if !foundActiveDB {
		t.Fatalf("default_limit did not expose active db_setting layer: %+v", defLimit["layers"])
	}

	if execDSN == nil {
		t.Fatal("text2sql.exec_dsn missing from effective settings")
	}
	if execDSN["value"] != "********" || execDSN["is_set"] != true || strings.Contains(fmt.Sprint(execDSN), "postgres://") {
		t.Fatalf("secret effective view leaked or was not masked: %+v", execDSN)
	}
}
