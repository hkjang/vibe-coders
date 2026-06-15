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

func TestSettingsRuntimeApply(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	enc := func(v string) string { b, _ := json.Marshal(v); return string(b) }

	// Prime a cached exec DB connection (sqlite file) so we can verify it gets swapped.
	dsn1 := "file:" + filepath.Join(t.TempDir(), "exec1.db") + "?cache=shared"
	if err := db.UpsertAdminSetting(ctx, store.AdminSetting{Key: "text2sql.exec_driver", Category: "text2sql", ValueJSON: enc("sqlite"), ValueType: "string", Source: "admin"}, "t", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAdminSetting(ctx, store.AdminSetting{Key: "text2sql.exec_dsn", Category: "text2sql", ValueJSON: enc(dsn1), ValueType: "string", IsSecret: true, Source: "admin"}, "t", ""); err != nil {
		t.Fatal(err)
	}
	server.reloadRuntimeConfig(ctx)
	conn1, err := server.text2sqlExecDB()
	if err != nil {
		t.Fatalf("open exec1: %v", err)
	}
	if server.t2sExec.Load() == nil {
		t.Fatal("exec DB should be cached after open")
	}

	// Change the DSN → reload should close+clear the cached connection (swap).
	dsn2 := "file:" + filepath.Join(t.TempDir(), "exec2.db") + "?cache=shared"
	encDSN2, _ := server.secrets.Encrypt(dsn2)
	if err := db.UpsertAdminSetting(ctx, store.AdminSetting{Key: "text2sql.exec_dsn", Category: "text2sql", ValueJSON: enc(encDSN2), ValueType: "string", IsSecret: true, Source: "admin"}, "t", ""); err != nil {
		t.Fatal(err)
	}
	server.reloadRuntimeConfig(ctx)
	if server.t2sExec.Load() != nil {
		t.Error("cached exec DB should be cleared after DSN change")
	}
	conn2, err := server.text2sqlExecDB()
	if err != nil {
		t.Fatalf("open exec2: %v", err)
	}
	if conn1 == conn2 {
		t.Error("expected a new *sql.DB after DSN swap")
	}
	if server.t2sConf().ExecDSN != dsn2 {
		t.Errorf("effective exec DSN = %q, want decrypted dsn2", server.t2sConf().ExecDSN)
	}

	// Connection test endpoint against an in-memory sqlite DSN should succeed.
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()
	resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/test/text2sql-exec", `{"dsn":"file::memory:?cache=shared","driver":"sqlite"}`)
	if resp.StatusCode != http.StatusOK || out["ok"] != true {
		t.Errorf("text2sql-exec test should pass, got status %d %+v", resp.StatusCode, out)
	}
}
