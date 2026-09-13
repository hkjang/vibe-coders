package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/tracking"
)

func putSetting(t *testing.T, base, key, value string) {
	t.Helper()
	body := `{"value":` + jsonString(value) + `,"reason":"tracking test"}`
	resp, out := req(t, http.MethodPut, base+"/admin/settings/by-key/"+key, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT %s = %d %v", key, resp.StatusCode, out)
	}
}

// settingValue reads one tracking setting back through the settings list, the
// way the console does.
func settingValue(t *testing.T, base, key string) (value string, source string) {
	t.Helper()
	_, list := req(t, http.MethodGet, base+"/admin/settings/tracking", "")
	items, _ := list["settings"].([]any)
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m["key"] == key {
			value, _ = m["value"].(string)
			source, _ = m["source"].(string)
			return value, source
		}
	}
	t.Fatalf("setting %s not listed in %v", key, list)
	return "", ""
}

func TestTrackingIsOffByDefault(t *testing.T) {
	ts, _ := settingsServer(t)

	_, status := req(t, http.MethodGet, ts.URL+"/admin/tracking/violations", "")
	if enabled, _ := status["enabled"].(bool); enabled || status["active"] != false || status["provider"] != "none" {
		t.Fatalf("default tracking status = %v", status)
	}
	if resp, _ := req(t, http.MethodPost, ts.URL+tracking.ReportPath, `{"csp-report":{"blocked-uri":"https://x.example/a.js"}}`); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("report endpoint while off = %d, want 404", resp.StatusCode)
	}
	if resp, _ := req(t, http.MethodGet, ts.URL+"/momento/tracker.js", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("momento proxy while off = %d, want 404", resp.StatusCode)
	}
	admin, err := http.Get(ts.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(admin.Body)
	admin.Body.Close()
	if admin.Header.Get("ETag") == "" || strings.Contains(string(page), "tracker.js") {
		t.Fatal("legacy console must be served exactly as before while tracking is off")
	}
}

func TestTrackingLegacyConsoleFollowsIncludeAdmin(t *testing.T) {
	ts, _ := settingsServer(t)
	putSetting(t, ts.URL, trackingProviderKey, tracking.ProviderMomento)
	putSetting(t, ts.URL, trackingMomentoURLKey, "https://momento.corp.example")
	putSetting(t, ts.URL, trackingMomentoSiteIDKey, "vibe")
	putSetting(t, ts.URL, trackingEnabledKey, "true")

	_, status := req(t, http.MethodGet, ts.URL+"/admin/tracking/violations", "")
	if status["active"] != true || status["momento_proxy"] != true || status["error"] != nil {
		t.Fatalf("status after enabling = %v", status)
	}

	admin, err := http.Get(ts.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(admin.Body)
	admin.Body.Close()
	if strings.Contains(string(page), "/momento/tracker.js") || admin.Header.Get("ETag") == "" {
		t.Fatal("legacy console must stay untracked while include_admin is off")
	}

	putSetting(t, ts.URL, trackingIncludeAdminKey, "true")
	admin, err = http.Get(ts.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	page, _ = io.ReadAll(admin.Body)
	admin.Body.Close()
	if !strings.Contains(string(page), `src="/momento/tracker.js"`) || !strings.Contains(string(page), `nonce="`) {
		t.Fatal("legacy console did not receive the nonced snippet")
	}
	if admin.Header.Get("Cache-Control") != "no-store" || admin.Header.Get("ETag") != "" {
		t.Fatalf("nonced legacy console must not be revalidatable: %v", admin.Header)
	}

	putSetting(t, ts.URL, trackingEnabledKey, "false")
	_, status = req(t, http.MethodGet, ts.URL+"/admin/tracking/violations", "")
	if status["active"] != false {
		t.Fatalf("status after disabling = %v", status)
	}
}

func TestTrackingViolationsAreRecordedListedAllowedAndCleared(t *testing.T) {
	ts, _ := settingsServer(t)
	putSetting(t, ts.URL, trackingProviderKey, tracking.ProviderCustom)
	putSetting(t, ts.URL, trackingCustomSnippetKey, `<script src="https://cdn.tracker.example/loader.js"></script>`)
	putSetting(t, ts.URL, trackingEnabledKey, "true")

	report := `{"csp-report":{"document-uri":"` + ts.URL + `/app/overview?x=1","blocked-uri":"https://collect.tracker.example/v1/events","effective-directive":"connect-src"}}`
	for i := 0; i < 3; i++ {
		if resp, _ := req(t, http.MethodPost, ts.URL+tracking.ReportPath, report); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("report = %d", resp.StatusCode)
		}
	}
	modern := `[{"type":"csp-violation","body":{"blockedURL":"https://cdn.tracker.example/px.gif","effectiveDirective":"img-src","documentURL":"` + ts.URL + `/app/"}}]`
	if resp, _ := req(t, http.MethodPost, ts.URL+tracking.ReportPath, modern); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("modern report = %d", resp.StatusCode)
	}
	if resp, _ := req(t, http.MethodPost, ts.URL+tracking.ReportPath, strings.Repeat("x", tracking.MaxReportBytes+1)); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized report = %d", resp.StatusCode)
	}

	_, status := req(t, http.MethodGet, ts.URL+"/admin/tracking/violations", "")
	violations, _ := status["violations"].([]any)
	if len(violations) != 2 {
		t.Fatalf("violations = %v", violations)
	}
	byOrigin := map[string]map[string]any{}
	for _, item := range violations {
		violation := item.(map[string]any)
		byOrigin[violation["origin"].(string)] = violation
	}
	collect := byOrigin["https://collect.tracker.example"]
	if collect == nil || collect["count"] != float64(3) || collect["directive"] != "connect-src" || collect["page"] != "/app/overview" || collect["allowed"] != false {
		t.Fatalf("collect violation = %v", collect)
	}
	// The origin the snippet itself names is already allowed by the policy.
	if cdn := byOrigin["https://cdn.tracker.example"]; cdn == nil || cdn["allowed"] != true {
		t.Fatalf("cdn violation = %v", cdn)
	}

	resp, status := req(t, http.MethodPost, ts.URL+"/admin/tracking/violations/allow", `{"origin":"https://collect.tracker.example/"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("allow = %d %v", resp.StatusCode, status)
	}
	hosts, _ := status["allowed_hosts"].([]any)
	if len(hosts) != 1 || hosts[0] != "https://collect.tracker.example" {
		t.Fatalf("allowed_hosts after allow = %v", hosts)
	}
	for _, item := range status["violations"].([]any) {
		if item.(map[string]any)["allowed"] != true {
			t.Fatalf("violation still blocked after allow: %v", item)
		}
	}
	if value, source := settingValue(t, ts.URL, trackingAllowedHostsKey); value != "https://collect.tracker.example" || source != "admin" {
		t.Fatalf("allowed_hosts setting = %q (%s)", value, source)
	}
	for _, bad := range []string{`{"origin":"javascript:alert(1)"}`, `{"origin":"https://x.example/path"}`, `{"origin":""}`, `nope`} {
		if resp, _ := req(t, http.MethodPost, ts.URL+"/admin/tracking/violations/allow", bad); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("allow %s = %d, want 400", bad, resp.StatusCode)
		}
	}

	resp, status = req(t, http.MethodDelete, ts.URL+"/admin/tracking/violations", "")
	if resp.StatusCode != http.StatusOK || len(status["violations"].([]any)) != 0 {
		t.Fatalf("clear = %d %v", resp.StatusCode, status)
	}
}

func TestTrackingRejectsOversizedSnippetAndUnknownProvider(t *testing.T) {
	ts, _ := settingsServer(t)
	big := "<script>" + strings.Repeat("x", tracking.MaxSnippetBytes) + "</script>"
	resp, _ := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+trackingCustomSnippetKey, `{"value":`+jsonString(big)+`}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized snippet = %d", resp.StatusCode)
	}
	if value, source := settingValue(t, ts.URL, trackingCustomSnippetKey); value != "" || source == "admin" {
		t.Fatalf("oversized snippet was stored: %q (%s)", value, source)
	}
	for key, value := range map[string]string{trackingProviderKey: "hotjar", trackingPlacementKey: "footer", trackingMomentoURLKey: "ftp://x"} {
		if resp, _ := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+key, `{"value":"`+value+`"}`); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s=%s accepted with %d", key, value, resp.StatusCode)
		}
	}
}

func TestMomentoProxyForwardsSameOriginTraffic(t *testing.T) {
	var seenPath, seenAuth, seenBody string
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		seenBody = string(body)
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte("// tracker"))
	}))
	t.Cleanup(collector.Close)

	ts, _ := settingsServer(t)
	putSetting(t, ts.URL, trackingProviderKey, tracking.ProviderMomento)
	putSetting(t, ts.URL, trackingMomentoURLKey, collector.URL+"/base/")
	putSetting(t, ts.URL, trackingMomentoSiteIDKey, "vibe")
	putSetting(t, ts.URL, trackingEnabledKey, "true")

	request, _ := http.NewRequest(http.MethodGet, ts.URL+"/momento/tracker.js", nil)
	request.Header.Set("Authorization", "Bearer operator-session")
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "// tracker" || seenPath != "/base/tracker.js" {
		t.Fatalf("proxied GET = %d %q path=%q", resp.StatusCode, body, seenPath)
	}
	if seenAuth != "" {
		t.Fatal("operator credentials must not reach the collector")
	}
	if resp, _ := req(t, http.MethodPost, ts.URL+"/momento/api/events", `{"e":1}`); resp.StatusCode != http.StatusOK || seenBody != `{"e":1}` || seenPath != "/base/api/events" {
		t.Fatalf("proxied POST = %d body=%q path=%q", resp.StatusCode, seenBody, seenPath)
	}
	if resp, _ := req(t, http.MethodDelete, ts.URL+"/momento/api/events", ""); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE through proxy = %d", resp.StatusCode)
	}

	putSetting(t, ts.URL, trackingMomentoProxyKey, "false")
	if resp, _ := req(t, http.MethodGet, ts.URL+"/momento/tracker.js", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("proxy after momento_proxy=false = %d", resp.StatusCode)
	}
}
