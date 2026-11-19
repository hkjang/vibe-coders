package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// Exercise the actual bootstrap projection and runtime settings. A retired UI
// feature remains available in /app; only its promoted Legacy route is removed.
func TestAppUIBootstrapLegacyRouteLifecycle(t *testing.T) {
	ts, _ := settingsServer(t)
	set := func(key, value string) {
		t.Helper()
		payload, err := json.Marshal(map[string]string{"value": value, "reason": "synthetic legacy lifecycle"})
		if err != nil {
			t.Fatal(err)
		}
		resp, _ := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+key, string(payload))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("set %s: %d", key, resp.StatusCode)
		}
	}
	for _, status := range []string{"preview", "preview_read_only", "stable", "deprecated", "retired", "hidden", "legacy"} {
		t.Run(status, func(t *testing.T) {
			set("ui.app.feature.text2sql.overview.status", status)
			resp, body := req(t, http.MethodGet, ts.URL+"/admin/ui-bootstrap", "")
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("bootstrap: %d", resp.StatusCode)
			}
			routes := body["legacy_route_map"].(map[string]any)
			_, linked := routes["/app/text2sql"]
			want := status != "retired" && status != "hidden"
			if linked != want {
				t.Fatalf("Legacy route for %s = %v, want %v", status, linked, want)
			}
			available := false
			for _, value := range body["allowed_features"].([]any) {
				if value == "text2sql.overview" {
					available = true
				}
			}
			if available != (status != "hidden") {
				t.Fatalf("app availability for %s = %v", status, available)
			}
			if _, ok := routes["/app/prompts/regression"]; ok {
				t.Fatal("per-feature fallback-disabled registry must not acquire a Legacy route")
			}
		})
	}
	set(appUILegacyFallbackKey, "false")
	_, body := req(t, http.MethodGet, ts.URL+"/admin/ui-bootstrap", "")
	if len(body["legacy_route_map"].(map[string]any)) != 0 {
		t.Fatal("global fallback opt-out must remove all promoted routes")
	}
	resp, err := http.Get(ts.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK || resp.Request.URL.Path != "/admin" {
		t.Fatal("direct /admin compatibility must remain unchanged")
	}
}
