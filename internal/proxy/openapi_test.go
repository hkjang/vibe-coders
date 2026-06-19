package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestOpenAPISwaggerAndVersion(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// openapi.json: valid JSON carrying the gateway version.
	resp, err := http.Get(srv.URL + "/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/openapi.json = %d", resp.StatusCode)
	}
	var spec map[string]any
	if err := json.Unmarshal(body, &spec); err != nil {
		t.Fatalf("openapi.json is not valid JSON: %v", err)
	}
	info, _ := spec["info"].(map[string]any)
	if info["version"] != AppVersion {
		t.Errorf("openapi version = %v, want %s", info["version"], AppVersion)
	}
	pathsMap, _ := spec["paths"].(map[string]any)
	if _, ok := pathsMap["/v1/chat/completions"]; !ok {
		t.Error("openapi.json missing /v1/chat/completions path")
	}
	// Comprehensive coverage: the spec should document the whole surface, not a handful.
	if len(pathsMap) < 120 {
		t.Errorf("expected comprehensive spec (>=120 paths), got %d", len(pathsMap))
	}
	for _, p := range []string{
		"/admin/text2sql/golden", "/admin/okf/documents", "/admin/llm/traces",
		"/me/keys", "/admin/settings/by-key/{key}", "/admin/dw/clickhouse/overview",
		"/admin/mcp/policies/{server}", "/admin/routing/decisions/{id}",
	} {
		if _, ok := pathsMap[p]; !ok {
			t.Errorf("openapi.json missing expected path %s", p)
		}
	}

	// swagger page renders and points at the spec.
	sw, err := http.Get(srv.URL + "/swagger")
	if err != nil {
		t.Fatal(err)
	}
	swBody, _ := io.ReadAll(sw.Body)
	sw.Body.Close()
	if sw.StatusCode != http.StatusOK || !strings.Contains(string(swBody), "/openapi.json") {
		t.Fatalf("/swagger should render and reference /openapi.json (status %d)", sw.StatusCode)
	}

	// /auth/me exposes the version (legacy/no-auth mode in testConfig).
	me, err := http.Get(srv.URL + "/auth/me")
	if err != nil {
		t.Fatal(err)
	}
	var meBody map[string]any
	json.NewDecoder(me.Body).Decode(&meBody)
	me.Body.Close()
	if meBody["version"] != AppVersion {
		t.Errorf("/auth/me version = %v, want %s", meBody["version"], AppVersion)
	}
}

func TestAppVersionNotBelowReleaseNotes(t *testing.T) {
	re := regexp.MustCompile(`v0\.(\d+)\.(\d+)`)
	paths := []string{
		filepath.Join("..", "..", "scripts", "gh_release.ps1"),
		filepath.Join("..", "..", "scripts", "changelog.txt"),
	}
	maxMinor, maxPatch := -1, -1
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read release notes source %s: %v", path, err)
		}
		matches := re.FindAllStringSubmatch(string(body), -1)
		if len(matches) == 0 {
			t.Fatalf("no v0.x.y release versions found in %s", path)
		}
		for _, m := range matches {
			minor, _ := strconv.Atoi(m[1])
			patch, _ := strconv.Atoi(m[2])
			if minor > maxMinor || (minor == maxMinor && patch > maxPatch) {
				maxMinor, maxPatch = minor, patch
			}
		}
	}
	appMinor, appPatch, ok := parseAppVersion(AppVersion)
	if !ok {
		t.Fatalf("AppVersion must use v0.x.y format, got %q", AppVersion)
	}
	if appMinor < maxMinor || (appMinor == maxMinor && appPatch < maxPatch) {
		t.Fatalf("AppVersion %s is below release notes max v0.%d.%d", AppVersion, maxMinor, maxPatch)
	}
}

func parseAppVersion(v string) (minor, patch int, ok bool) {
	re := regexp.MustCompile(`^v0\.(\d+)\.(\d+)$`)
	m := re.FindStringSubmatch(strings.TrimSpace(v))
	if len(m) != 3 {
		return 0, 0, false
	}
	minor, _ = strconv.Atoi(m[1])
	patch, _ = strconv.Atoi(m[2])
	return minor, patch, true
}
