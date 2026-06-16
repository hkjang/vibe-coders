package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestValidCHIdentifier(t *testing.T) {
	ok := []string{"", "ai_request_rollup", "ai_gateway.analytics_daily", "T1", "_x", "db.tbl"}
	for _, s := range ok {
		if !validCHIdentifier(s) {
			t.Errorf("expected %q to be a valid identifier", s)
		}
	}
	bad := []string{
		"rollup' OR '1'='1",
		"x; DROP TABLE y",
		"a.b.c",
		"1table",
		"tbl name",
		"tbl`",
		"db.",
		".tbl",
	}
	for _, s := range bad {
		if validCHIdentifier(s) {
			t.Errorf("expected %q to be rejected", s)
		}
	}
}

func TestClickHouseBootstrapRejectsBadIdentifier(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "ch.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	// URL set so bootstrap proceeds to the identifier check; a malicious table name must be
	// rejected before any DDL is issued (no ClickHouse server is reachable here).
	server.chRuntime.Store(&config.ClickHouseConfig{URL: "http://ch.invalid", Table: "rollup' OR '1'='1"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/admin/dw/clickhouse/bootstrap", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for injected table name, got %d", resp.StatusCode)
	}
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Error.Code != "invalid_identifier" {
		t.Fatalf("expected invalid_identifier code, got %q", out.Error.Code)
	}
}

func TestSettingsRejectBadCHIdentifier(t *testing.T) {
	var def *settingDef
	for i := range settingRegistry {
		if settingRegistry[i].Key == "clickhouse.table" {
			def = &settingRegistry[i]
			break
		}
	}
	if def == nil {
		t.Fatal("clickhouse.table setting not found in registry")
	}
	if err := validateSettingValue(*def, "ai_request_rollup"); err != nil {
		t.Fatalf("valid table name rejected: %v", err)
	}
	if err := validateSettingValue(*def, "rollup' OR '1'='1"); err == nil {
		t.Fatal("expected injected table name to be rejected by settings validation")
	}
}
