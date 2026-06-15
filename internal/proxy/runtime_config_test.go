package proxy

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestRuntimeConfigOverlay(t *testing.T) {
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

	// Baseline: no overlay → env/default (testConfig leaves Text2SQL zero-valued).
	if got := server.t2sConf().DefaultLimit; got != 0 {
		t.Fatalf("baseline default_limit = %d, want 0", got)
	}

	enc := func(v string) string { b, _ := json.Marshal(v); return string(b) }
	put := func(key, valueType, valueJSON string, secret bool) {
		if err := db.UpsertAdminSetting(ctx, store.AdminSetting{
			Key: key, Category: "text2sql", ValueJSON: valueJSON, ValueType: valueType, IsSecret: secret, Source: "admin",
		}, "tester", ""); err != nil {
			t.Fatal(err)
		}
	}

	// Plain overlays.
	put("text2sql.default_limit", "int", enc("50"), false)
	put("text2sql.mask_results", "bool", enc("false"), false)
	put("text2sql.preview_model", "string", enc("gpt-4.1-mini-x"), false)
	put("clickhouse.table", "string", enc("ch_facts"), false)
	put("carbon.pue", "float", enc("1.5"), false)
	put("insurance.sla_target", "float", enc("0.995"), false)

	// Secret overlay: store encrypted, expect decrypted at runtime.
	cipher, err := server.secrets.Encrypt("postgres://u:p@h/db")
	if err != nil {
		t.Fatal(err)
	}
	put("text2sql.exec_dsn", "string", enc(cipher), true)

	server.reloadRuntimeConfig(ctx)

	t2s := server.t2sConf()
	if t2s.DefaultLimit != 50 {
		t.Errorf("default_limit = %d, want 50", t2s.DefaultLimit)
	}
	if t2s.MaskResults != false {
		t.Errorf("mask_results = %v, want false", t2s.MaskResults)
	}
	if t2s.PreviewModel != "gpt-4.1-mini-x" {
		t.Errorf("preview_model = %q, want gpt-4.1-mini-x", t2s.PreviewModel)
	}
	if t2s.ExecDSN != "postgres://u:p@h/db" {
		t.Errorf("exec_dsn = %q, want decrypted plaintext", t2s.ExecDSN)
	}
	if server.chConf().Table != "ch_facts" {
		t.Errorf("clickhouse table = %q, want ch_facts", server.chConf().Table)
	}
	if got := server.carbonConf().PUE; got < 1.49 || got > 1.51 {
		t.Errorf("carbon PUE = %f, want 1.5", got)
	}
	if got := server.insuranceConf().SLATarget; got < 0.994 || got > 0.996 {
		t.Errorf("insurance SLA target = %f, want 0.995", got)
	}
}
