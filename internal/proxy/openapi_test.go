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
		"/admin/mcp/policies/{server}", "/admin/routing/decisions/{id}", "/admin/ui-bootstrap",
	} {
		if _, ok := pathsMap[p]; !ok {
			t.Errorf("openapi.json missing expected path %s", p)
		}
	}
	assertOpenAPIContract(t, spec)

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
	if strings.Contains(string(swBody), "unpkg.com") || strings.Contains(string(swBody), `src="http`) || strings.Contains(string(swBody), `href="http`) {
		t.Fatal("/swagger must not depend on external runtime assets")
	}
	if csp := sw.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'nonce-") || strings.Contains(csp, "unsafe-eval") {
		t.Fatalf("/swagger CSP = %q", csp)
	}
	if strings.Contains(string(swBody), "{{NONCE}}") || !strings.Contains(string(swBody), `nonce="`) {
		t.Fatal("/swagger must replace its CSP nonce placeholder")
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

func assertOpenAPIContract(t *testing.T, spec map[string]any) {
	t.Helper()
	paths, _ := spec["paths"].(map[string]any)
	operationIDs := map[string]string{}
	for route, rawPath := range paths {
		pathItem, _ := rawPath.(map[string]any)
		for method, rawOperation := range pathItem {
			operation, ok := rawOperation.(map[string]any)
			if !ok || operation["responses"] == nil {
				continue
			}
			operationID, _ := operation["operationId"].(string)
			if operationID == "" {
				t.Errorf("%s %s has no operationId", method, route)
				continue
			}
			if previous, duplicate := operationIDs[operationID]; duplicate {
				t.Errorf("duplicate operationId %q on %s %s and %s", operationID, method, route, previous)
			}
			operationIDs[operationID] = method + " " + route
		}
	}

	components, _ := spec["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	for _, required := range []string{
		"AppError", "HealthResponse", "AuthTokenResponse", "AuthMeResponse", "SSOExchangeRequest",
		"KeycloakLogoutRequest", "KeycloakLogoutResponse", "MigrationFeature", "UIRuntimeConfig",
		"UIAuthentication", "UISystemStatus", "UIBootstrapResponse", "SettingWriteRequest",
		"SettingBatchItem", "SettingsBatchRequest", "SettingsBatchResponse", "AdminSettingView",
	} {
		if _, ok := schemas[required]; !ok {
			t.Errorf("components.schemas missing %s", required)
		}
	}
	walkOpenAPIValue(spec, func(ref string) {
		const prefix = "#/components/schemas/"
		if !strings.HasPrefix(ref, prefix) {
			t.Errorf("unsupported local OpenAPI reference %q", ref)
			return
		}
		if _, ok := schemas[strings.TrimPrefix(ref, prefix)]; !ok {
			t.Errorf("unresolved OpenAPI schema reference %q", ref)
		}
	})

	tokenSchema, _ := schemas["AuthTokenResponse"].(map[string]any)
	required, _ := tokenSchema["required"].([]any)
	for _, field := range required {
		if field == "user" {
			t.Error("AuthTokenResponse.user must be optional because refresh responses omit it")
		}
	}
	authMe, _ := schemas["AuthMeResponse"].(map[string]any)
	authMeProperties, _ := authMe["properties"].(map[string]any)
	menuVersion, _ := authMeProperties["menu_version"].(map[string]any)
	if menuVersion["type"] != "integer" {
		t.Errorf("AuthMeResponse.menu_version type = %v, want integer", menuVersion["type"])
	}

	assertJSONOperationSchema(t, paths, "/health", "get", "200", "HealthResponse")
	assertJSONOperationSchema(t, paths, "/auth/sso/exchange", "post", "200", "AuthTokenResponse")
	assertJSONRequestSchema(t, paths, "/auth/sso/exchange", "post", "SSOExchangeRequest")
	assertJSONOperationSchema(t, paths, "/auth/keycloak/logout", "post", "200", "KeycloakLogoutResponse")
	assertJSONRequestSchema(t, paths, "/auth/keycloak/logout", "post", "KeycloakLogoutRequest")
	assertJSONRequestSchema(t, paths, "/admin/settings/by-key/{key}", "put", "SettingWriteRequest")
	assertJSONRequestSchema(t, paths, "/admin/settings/bulk", "put", "SettingsBatchRequest")
	assertOpenAPIParameter(t, paths, "/admin/settings/by-key/{key}", "delete", "path", "key")
	assertOpenAPIParameter(t, paths, "/admin/settings/by-key/{key}", "delete", "query", "expected_version")
	bootstrap, _ := schemas["UIBootstrapResponse"].(map[string]any)
	bootstrapProperties, _ := bootstrap["properties"].(map[string]any)
	for field, want := range map[string]string{"ui": "UIRuntimeConfig", "authentication": "UIAuthentication", "system_status": "UISystemStatus"} {
		got, _ := bootstrapProperties[field].(map[string]any)
		if got["$ref"] != "#/components/schemas/"+want {
			t.Errorf("UIBootstrapResponse.%s schema = %v, want %s", field, got, want)
		}
	}
}

func assertOpenAPIParameter(t *testing.T, paths map[string]any, route, method, location, name string) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	op, _ := pathItem[method].(map[string]any)
	parameters, _ := op["parameters"].([]any)
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		if parameter["in"] == location && parameter["name"] == name {
			return
		}
	}
	t.Errorf("%s %s missing %s parameter %q", method, route, location, name)
}

func assertJSONOperationSchema(t *testing.T, paths map[string]any, route, method, status, schema string) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	op, _ := pathItem[method].(map[string]any)
	responses, _ := op["responses"].(map[string]any)
	response, _ := responses[status].(map[string]any)
	content, _ := response["content"].(map[string]any)
	jsonBody, _ := content["application/json"].(map[string]any)
	got, _ := jsonBody["schema"].(map[string]any)
	if got["$ref"] != "#/components/schemas/"+schema {
		t.Errorf("%s %s response %s schema = %v, want %s", method, route, status, got, schema)
	}
}

func assertJSONRequestSchema(t *testing.T, paths map[string]any, route, method, schema string) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	op, _ := pathItem[method].(map[string]any)
	body, _ := op["requestBody"].(map[string]any)
	content, _ := body["content"].(map[string]any)
	jsonBody, _ := content["application/json"].(map[string]any)
	got, _ := jsonBody["schema"].(map[string]any)
	if got["$ref"] != "#/components/schemas/"+schema {
		t.Errorf("%s %s request schema = %v, want %s", method, route, got, schema)
	}
}

func walkOpenAPIValue(value any, visitRef func(string)) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "$ref" {
				if ref, ok := child.(string); ok {
					visitRef(ref)
				}
				continue
			}
			walkOpenAPIValue(child, visitRef)
		}
	case []any:
		for _, child := range typed {
			walkOpenAPIValue(child, visitRef)
		}
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
