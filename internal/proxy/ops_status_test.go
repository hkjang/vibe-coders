package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
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
	if len(got.PartialFailures) != 0 {
		t.Errorf("healthy status unexpectedly reported partial failures: %+v", got.PartialFailures)
	}
}

func TestOpsStatusSurfacesProviderAndFallbackFailures(t *testing.T) {
	db := openTestStore(t)
	// A directory can be statted but not scanned as the fallback NDJSON file.
	// This gives FallbackStats a deterministic read failure without permissions.
	logger := store.NewAsyncLogger(db, 8, t.TempDir())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	status := server.opsStatusSnapshot(context.Background())
	if status.Providers == nil {
		t.Fatal("provider failure must retain a stable empty array")
	}
	wantFailures := map[string]string{
		"providers": "provider_health_unavailable",
		"fallback":  "fallback_stats_unavailable",
	}
	for _, failure := range status.PartialFailures {
		if want, ok := wantFailures[failure.Component]; !ok {
			t.Errorf("unexpected partial failure component: %+v", failure)
		} else if failure.Code != want {
			t.Errorf("partial failure %q code = %q, want %q", failure.Component, failure.Code, want)
		} else if failure.Message == "" {
			t.Errorf("partial failure %q has no safe operator message", failure.Component)
		} else {
			delete(wantFailures, failure.Component)
		}
	}
	if len(wantFailures) != 0 {
		t.Fatalf("missing partial failures: %v (got %+v)", wantFailures, status.PartialFailures)
	}

	risk := opsRiskScore(status)
	for _, code := range []string{"provider_health_unavailable", "fallback_stats_unavailable"} {
		found := false
		for _, factor := range risk.Factors {
			if factor.Key == code {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("risk must surface partial failure %q: %+v", code, risk.Factors)
		}
	}
}

func TestOpsRiskResponseUsesEmbeddedStatusSnapshot(t *testing.T) {
	status := OpsStatus{
		GeneratedAt: "2026-09-02T01:02:03Z",
		Security:    OpsSecurityStatus{AuthEnabled: true, PricingConfigured: true},
		PartialFailures: []OpsStatusPartialFailure{{
			Component: "providers",
			Code:      "provider_health_unavailable",
			Message:   "Provider health data is temporarily unavailable.",
		}},
	}

	response := buildOpsRiskResponse(status)
	if !reflect.DeepEqual(response.Status, status) {
		t.Fatalf("risk response status = %+v, want original snapshot %+v", response.Status, status)
	}
	if want := opsRiskScore(response.Status); !reflect.DeepEqual(response.Risk, want) {
		t.Fatalf("risk response = %+v, want score from embedded status %+v", response.Risk, want)
	}
}
