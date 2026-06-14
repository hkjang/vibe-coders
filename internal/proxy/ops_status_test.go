package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestOpsStatusReportsConfigAndDisk(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	// Force the insecure default secret + raw prompt logging so the snapshot flags them.
	cfg.Secret.GatewaySecret = config.DefaultGatewaySecret
	cfg.Logging.RawPrompts = true

	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/admin/ops/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}

	var got OpsStatus
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}

	if !got.Security.DevSecret {
		t.Error("expected dev_secret=true when GATEWAY_SECRET is the default")
	}
	if !got.Security.RawPromptsLogged {
		t.Error("expected raw_prompts_logged=true")
	}
	if !got.Security.PricingConfigured {
		t.Error("expected pricing_configured=true (testConfig sets a price)")
	}
	if got.Security.AuthEnabled {
		t.Error("expected auth_enabled=false")
	}
	if got.Disk.Path == "" {
		t.Error("expected a disk path to be reported")
	}
	if got.Disk.Available && got.Disk.TotalBytes == 0 {
		t.Error("disk reported available but total bytes is zero")
	}
	if got.GeneratedAt == "" {
		t.Error("expected generated_at timestamp")
	}
}
