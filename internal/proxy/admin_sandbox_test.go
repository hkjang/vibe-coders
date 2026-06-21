package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func sandboxPreview(t *testing.T, url string, body map[string]any) map[string]any {
	t.Helper()
	enc, _ := json.Marshal(body)
	resp, err := http.Post(url+"/admin/sandbox/preview", "application/json", bytes.NewReader(enc))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, raw)
	}
	return out
}

func TestSandboxPreviewBlocksUnsafeSQL(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fb.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Destructive SQL must be flagged would_block with a failed validation.
	bad := sandboxPreview(t, proxy.URL, map[string]any{"kind": "text2sql", "sql": "DROP TABLE users"})
	if bad["would_block"] != true {
		t.Fatalf("DROP should block, got %+v", bad)
	}
	checks, _ := bad["checks"].(map[string]any)
	v, _ := checks["text2sql_validation"].(map[string]any)
	if v == nil || v["ok"] != false {
		t.Fatalf("expected failed SQL validation, got %+v", checks)
	}

	// A plain SELECT passes (no policies configured).
	ok := sandboxPreview(t, proxy.URL, map[string]any{"kind": "text2sql", "sql": "SELECT id FROM users"})
	if ok["would_block"] != false {
		t.Fatalf("SELECT should pass, got %+v", ok)
	}
}
