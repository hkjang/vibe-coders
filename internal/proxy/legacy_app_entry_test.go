package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestLegacyAppEntryDefaultAndRuntimeSettings(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "true")
	t.Setenv("UI_APP_LEGACY_ENTRY_LINK", "")
	gateway, _ := settingsServer(t)
	check := func(want bool) {
		t.Helper()
		response, body := req(t, http.MethodGet, gateway.URL+"/me/navigation", "")
		if response.StatusCode != http.StatusOK || body["app_entry_enabled"] != want {
			t.Fatalf("navigation status=%d app_entry_enabled=%v want=%v", response.StatusCode, body["app_entry_enabled"], want)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("navigation configuration must not be cached")
		}
	}
	set := func(key, value string, status int) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"value": value, "reason": "test Legacy entry configuration"})
		response, _ := req(t, http.MethodPut, gateway.URL+"/admin/settings/by-key/"+key, string(body))
		if response.StatusCode != status {
			t.Fatalf("set %s status=%d want=%d", key, response.StatusCode, status)
		}
	}
	page := func(etag string) (string, string, int) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodGet, gateway.URL+"/admin", nil)
		request.Header.Set("If-None-Match", etag)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(content), response.Header.Get("ETag"), response.StatusCode
	}
	check(false)
	before, etag, status := page("")
	if status != http.StatusOK || !strings.Contains(before, `id="legacy-app-entry"`) {
		t.Fatal("missing inert entry anchor")
	}
	set("ui.app.legacy_entry_link", "true", http.StatusOK)
	check(true)
	after, nextETag, status := page("")
	if status != http.StatusOK || after != before || nextETag != etag {
		t.Fatal("runtime configuration changed shared static HTML")
	}
	_, _, status = page(etag)
	if status != http.StatusNotModified {
		t.Fatalf("cached document status=%d", status)
	}
	set("ui.app.enabled", "false", http.StatusOK)
	check(false)
	set("ui.app.enabled", "true", http.StatusOK)
	check(true)
	set("ui.app.legacy_entry_link", "not-a-bool", http.StatusBadRequest)
	check(true)
	set("ui.app.legacy_entry_link", "false", http.StatusOK)
	check(false)
}

func TestLegacyAppEntryEnvironmentAndTokenBoundary(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "true")
	t.Setenv("UI_APP_LEGACY_ENTRY_LINK", "true")
	_, _, gateway := newAdminModelsTestServer(t, "public-test-admin-token")
	for _, tc := range []struct {
		token string
		want  bool
	}{
		{"", false}, {"public-wrong-token", false}, {"public-test-admin-token", true},
	} {
		request, _ := http.NewRequest(http.MethodGet, gateway.URL+"/me/navigation", nil)
		if tc.token != "" {
			request.Header.Set("Authorization", "Bearer "+tc.token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		err = json.NewDecoder(response.Body).Decode(&body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || body["app_entry_enabled"] != tc.want {
			t.Fatalf("Legacy navigation status=%d app_entry_enabled=%v want=%v", response.StatusCode, body["app_entry_enabled"], tc.want)
		}
	}
}

func TestLegacyAppEntryAuthenticatedNavigation(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "true")
	t.Setenv("UI_APP_LEGACY_ENTRY_LINK", "true")
	_, gateway := newAuthTestServer(t, "http://unused.invalid")
	defer gateway.Close()
	response, _ := req(t, http.MethodGet, gateway.URL+"/me/navigation", "")
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous navigation status=%d", response.StatusCode)
	}
	login := postJSON(t, gateway.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var tokens struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if tokens.AccessToken == "" {
		t.Fatal("test login failed")
	}
	request, _ := http.NewRequest(http.MethodGet, gateway.URL+"/me/navigation", nil)
	request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || body["app_entry_enabled"] != true {
		t.Fatalf("authenticated navigation status=%d enabled=%v", response.StatusCode, body["app_entry_enabled"])
	}
}
