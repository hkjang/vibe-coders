package proxy

import (
	"net/http"
	"testing"

	"vibe-coders/internal/audit"
)

func TestPricingFallbackRuntimeSetting(t *testing.T) {
	ts, _ := settingsServer(t)
	base := ts.URL + "/admin/settings"

	// NewServer applied the env default (qwen-plus) at startup.
	if audit.FallbackPriceModel() != "qwen-plus" {
		t.Fatalf("default fallback = %q, want qwen-plus", audit.FallbackPriceModel())
	}

	// Change the fallback model at runtime → takes effect immediately (no restart).
	resp, _ := req(t, http.MethodPut, base+"/by-key/pricing.fallback_model", `{"value":"gpt-4o-mini"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set fallback = %d", resp.StatusCode)
	}
	if audit.FallbackPriceModel() != "gpt-4o-mini" {
		t.Errorf("after set, fallback = %q, want gpt-4o-mini", audit.FallbackPriceModel())
	}

	// usd_krw is adjustable and surfaced as an admin override.
	resp, _ = req(t, http.MethodPut, base+"/by-key/pricing.usd_krw", `{"value":"1500"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set usd_krw = %d", resp.StatusCode)
	}
	_, list := req(t, http.MethodGet, base+"/pricing", "")
	foundRate := false
	for _, it := range list["settings"].([]any) {
		m := it.(map[string]any)
		if m["key"] == "pricing.usd_krw" && m["value"] == "1500" && m["source"] == "admin" {
			foundRate = true
		}
	}
	if !foundRate {
		t.Error("pricing.usd_krw override not reflected in settings list")
	}

	// Reverting the fallback model restores the default.
	resp, _ = req(t, http.MethodDelete, base+"/by-key/pricing.fallback_model", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revert fallback = %d", resp.StatusCode)
	}
	if audit.FallbackPriceModel() != "qwen-plus" {
		t.Errorf("after revert, fallback = %q, want qwen-plus", audit.FallbackPriceModel())
	}
}
