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
	"sort"
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
		"ReadyResponse", "ReadinessFailureResponse", "AdminStatsResponse", "OpsStatus", "OpsStatusPartialFailure", "OpsRiskResponse", "ProviderHealthScore",
		"RoutingHealthResponse", "RoutingBreakerSummary", "ProviderPublic", "ProviderListResponse",
		"AgentRoute", "AgentRouteWriteRequest", "AgentRouteListResponse", "AgentRouteWriteResponse",
		"AdminModel", "AdminModelDeprecation", "AdminModelProvider", "AdminModelPartialFailure", "AdminModelsResponse",
		"ProviderSLO", "ProviderSLOMetric", "ProviderSLOEvaluation", "ProviderSLOResponse", "ProviderSLOWriteRequest", "ProviderSLOWriteResponse", "ProviderSLODeleteResponse",
		"ModelQualityScore", "ModelQualityResponse", "ModelPrice", "ModelPricingVersion", "PricingResponse", "PricingWriteRequest", "PricingWriteResponse",
		"ModelUsageTag", "ModelUsageTagsResponse",
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
	opsStatus, _ := schemas["OpsStatus"].(map[string]any)
	opsStatusProperties, _ := opsStatus["properties"].(map[string]any)
	partialFailures, _ := opsStatusProperties["partial_failures"].(map[string]any)
	partialFailureItems, _ := partialFailures["items"].(map[string]any)
	if partialFailureItems["$ref"] != "#/components/schemas/OpsStatusPartialFailure" {
		t.Errorf("OpsStatus.partial_failures schema = %v, want OpsStatusPartialFailure array", partialFailures)
	}
	adminModel, _ := schemas["AdminModel"].(map[string]any)
	adminModelProperties, _ := adminModel["properties"].(map[string]any)
	adminModelRequired, _ := adminModel["required"].([]any)
	requiredAdminModelFields := make(map[string]bool, len(adminModelRequired))
	for _, field := range adminModelRequired {
		if name, ok := field.(string); ok {
			requiredAdminModelFields[name] = true
		}
	}
	for field, wantType := range map[string]string{"shadowed": "boolean", "shadowed_by": "string"} {
		property, _ := adminModelProperties[field].(map[string]any)
		if property["type"] != wantType || !requiredAdminModelFields[field] {
			t.Errorf("AdminModel.%s schema = %v required=%v, want required %s", field, property, requiredAdminModelFields[field], wantType)
		}
	}
	created, _ := adminModelProperties["created"].(map[string]any)
	if created["type"] != "integer" || created["format"] != "int64" || created["nullable"] != true || created["minimum"] != float64(0) || created["maximum"] != float64(maxAdminModelCreated) {
		t.Errorf("AdminModel.created schema = %v, want nullable JavaScript-safe non-negative int64", created)
	}
	for _, schemaName := range []string{"ProviderPublic", "ProviderSLO", "ProviderSLOEvaluation", "ProviderSLODeleteResponse", "ProviderHealthScore", "ProviderHealthRankingItem", "ProviderHealthAlert", "RoutingBreakerState", "AgentRoute", "AdminModel", "AdminModelProvider", "AdminModelPartialFailure"} {
		schema, _ := schemas[schemaName].(map[string]any)
		properties, _ := schema["properties"].(map[string]any)
		providerRef, _ := properties["provider_ref"].(map[string]any)
		requiredFields, _ := schema["required"].([]any)
		providerRefRequired := false
		for _, field := range requiredFields {
			if field == "provider_ref" {
				providerRefRequired = true
				break
			}
		}
		wantRequired := strings.HasPrefix(schemaName, "AdminModel")
		if providerRefRequired != wantRequired || providerRef["type"] != "string" || providerRef["minLength"] != float64(providerRefLength) || providerRef["maxLength"] != float64(providerRefLength) || providerRef["pattern"] != `^prv_[A-Za-z0-9_-]{43}$` {
			t.Errorf("%s.provider_ref schema = %v required=%v wantRequired=%v", schemaName, providerRef, providerRefRequired, wantRequired)
		}
	}
	agentRouteWrite, _ := schemas["AgentRouteWriteRequest"].(map[string]any)
	agentRouteWriteProperties, _ := agentRouteWrite["properties"].(map[string]any)
	if _, acceptsProviderRef := agentRouteWriteProperties["provider_ref"]; acceptsProviderRef {
		t.Error("AgentRouteWriteRequest.provider_ref must be output-only")
	}
	providerSLOEvaluation, _ := schemas["ProviderSLOEvaluation"].(map[string]any)
	providerSLOEvaluationProperties, _ := providerSLOEvaluation["properties"].(map[string]any)
	providerSLOMetrics, _ := providerSLOEvaluationProperties["metrics"].(map[string]any)
	if providerSLOMetrics["additionalProperties"] != false {
		t.Errorf("ProviderSLOEvaluation.metrics additionalProperties = %v, want false", providerSLOMetrics["additionalProperties"])
	}
	providerSLOMetricProperties, _ := providerSLOMetrics["properties"].(map[string]any)
	providerSLOMetricRequired, _ := providerSLOMetrics["required"].([]any)
	requiredProviderSLOMetrics := make(map[string]bool, len(providerSLOMetricRequired))
	for _, field := range providerSLOMetricRequired {
		if name, ok := field.(string); ok {
			requiredProviderSLOMetrics[name] = true
		}
	}
	for _, field := range []string{"availability", "p95_latency_ms", "error_rate", "fallback_rate"} {
		property, _ := providerSLOMetricProperties[field].(map[string]any)
		if property["$ref"] != "#/components/schemas/ProviderSLOMetric" || !requiredProviderSLOMetrics[field] {
			t.Errorf("ProviderSLOEvaluation.metrics.%s schema = %v required=%v", field, property, requiredProviderSLOMetrics[field])
		}
	}
	if len(providerSLOMetricProperties) != 4 || len(requiredProviderSLOMetrics) != 4 {
		t.Errorf("ProviderSLOEvaluation.metrics properties/required = %d/%d, want exactly 4/4", len(providerSLOMetricProperties), len(requiredProviderSLOMetrics))
	}
	providerSLOMetric, _ := schemas["ProviderSLOMetric"].(map[string]any)
	providerSLOMetricShape, _ := providerSLOMetric["properties"].(map[string]any)
	providerSLOMetricFields, _ := providerSLOMetric["required"].([]any)
	if providerSLOMetric["additionalProperties"] != false || len(providerSLOMetricShape) != 4 || len(providerSLOMetricFields) != 4 {
		t.Errorf("ProviderSLOMetric shape = properties:%v required:%v additionalProperties:%v", providerSLOMetricShape, providerSLOMetricFields, providerSLOMetric["additionalProperties"])
	}
	adminModels, _ := schemas["AdminModelsResponse"].(map[string]any)
	adminModelsProperties, _ := adminModels["properties"].(map[string]any)
	adminModelsRows, _ := adminModelsProperties["models"].(map[string]any)
	if adminModelsRows["maxItems"] != float64(maxAdminModelsResponseRows) {
		t.Errorf("AdminModelsResponse.models maxItems = %v, want %d", adminModelsRows["maxItems"], maxAdminModelsResponseRows)
	}
	modelsPath, _ := paths["/v1/models"].(map[string]any)
	modelsGet, _ := modelsPath["get"].(map[string]any)
	modelsResponses, _ := modelsGet["responses"].(map[string]any)
	modelsOK, _ := modelsResponses["200"].(map[string]any)
	modelsHeaders, _ := modelsOK["headers"].(map[string]any)
	for _, header := range []string{"X-Models-Providers", "X-Models-Providers-Failed", "X-Models-Providers-Skipped", "X-Models-Metadata-Omitted", "X-Models-Truncated"} {
		if _, ok := modelsHeaders[header]; !ok {
			t.Errorf("GET /v1/models 200 response missing %s header contract", header)
		}
	}

	assertJSONOperationSchema(t, paths, "/health", "get", "200", "HealthResponse")
	assertJSONOperationSchema(t, paths, "/ready", "get", "200", "ReadyResponse")
	assertJSONOperationSchema(t, paths, "/ready", "get", "503", "ReadinessFailureResponse")
	assertJSONOperationSchema(t, paths, "/admin/stats", "get", "200", "AdminStatsResponse")
	assertJSONOperationSchema(t, paths, "/admin/ops/status", "get", "200", "OpsStatus")
	assertJSONOperationSchema(t, paths, "/admin/ops/risk", "get", "200", "OpsRiskResponse")
	assertJSONOperationSchema(t, paths, "/admin/routing/health", "get", "200", "RoutingHealthResponse")
	assertOpenAPIParameter(t, paths, "/admin/routing/health", "get", "query", "window")
	assertOpenAPIParameter(t, paths, "/admin/routing/health", "get", "query", "threshold")
	assertOpenAPIParameterSchema(t, paths, "/v1/models", "get", "query", "provider", "string", false)
	assertJSONOperationSchema(t, paths, "/admin/providers", "get", "200", "ProviderListResponse")
	assertJSONOperationSchema(t, paths, "/admin/models", "get", "200", "AdminModelsResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/models", "get", "query", "provider", "string", false)
	assertOpenAPIParameterSchema(t, paths, "/admin/models", "get", "query", "model", "string", false)
	assertJSONOperationSchema(t, paths, "/admin/providers/slo", "get", "200", "ProviderSLOResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/providers/slo", "get", "query", "window", "string", false)
	assertJSONRequestSchema(t, paths, "/admin/providers/slo", "post", "ProviderSLOWriteRequest")
	assertJSONOperationSchema(t, paths, "/admin/providers/slo", "post", "201", "ProviderSLOWriteResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/providers/slo", "delete", "query", "provider", "string", true)
	assertJSONOperationSchema(t, paths, "/admin/providers/slo", "delete", "200", "ProviderSLODeleteResponse")
	assertJSONOperationSchema(t, paths, "/admin/agent-routes", "get", "200", "AgentRouteListResponse")
	assertJSONRequestSchema(t, paths, "/admin/agent-routes", "post", "AgentRouteWriteRequest")
	assertJSONOperationSchema(t, paths, "/admin/agent-routes", "post", "201", "AgentRouteWriteResponse")
	assertJSONOperationSchema(t, paths, "/admin/models/quality", "get", "200", "ModelQualityResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/models/quality", "get", "query", "window", "string", false)
	assertJSONOperationSchema(t, paths, "/admin/pricing", "get", "200", "PricingResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/pricing", "get", "query", "model", "string", false)
	assertOpenAPIParameterSchema(t, paths, "/admin/pricing", "get", "query", "limit", "integer", false)
	assertJSONRequestSchema(t, paths, "/admin/pricing", "post", "PricingWriteRequest")
	assertJSONOperationSchema(t, paths, "/admin/pricing", "post", "201", "PricingWriteResponse")
	assertJSONOperationSchema(t, paths, "/admin/model-tags", "get", "200", "ModelUsageTagsResponse")
	assertJSONOperationSchema(t, paths, "/v1/model-tags", "get", "200", "ModelUsageTagsResponse")
	assertOpenAPIMethods(t, paths, "/admin/providers/{name}", "delete")
	assertOpenAPIMethods(t, paths, "/admin/providers/slo", "delete", "get", "post")
	assertOpenAPIPublic(t, paths, "/v1/models", "get")
	assertOpenAPIPropertyFormat(t, schemas, "ProviderSLO", "updated_at", "date-time")
	assertOpenAPIPropertyFormat(t, schemas, "ModelPricingVersion", "created_at", "date-time")
	assertOpenAPIPropertyFormat(t, schemas, "ModelUsageTag", "updated_at", "date-time")
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

func assertOpenAPIMethods(t *testing.T, paths map[string]any, route string, expected ...string) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	got := make([]string, 0, len(pathItem))
	for method, operation := range pathItem {
		if _, ok := operation.(map[string]any); ok {
			got = append(got, method)
		}
	}
	sort.Strings(got)
	sort.Strings(expected)
	if strings.Join(got, ",") != strings.Join(expected, ",") {
		t.Errorf("%s methods = %v, want %v", route, got, expected)
	}
}

func assertOpenAPIPublic(t *testing.T, paths map[string]any, route, method string) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	op, _ := pathItem[method].(map[string]any)
	if _, secured := op["security"]; secured {
		t.Errorf("%s %s unexpectedly requires OpenAPI bearerAuth", method, route)
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

func assertOpenAPIParameterSchema(t *testing.T, paths map[string]any, route, method, location, name, schemaType string, required bool) {
	t.Helper()
	pathItem, _ := paths[route].(map[string]any)
	op, _ := pathItem[method].(map[string]any)
	parameters, _ := op["parameters"].([]any)
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		if parameter["in"] != location || parameter["name"] != name {
			continue
		}
		if parameter["required"] != required {
			t.Errorf("%s %s %s parameter %q required = %v, want %v", method, route, location, name, parameter["required"], required)
		}
		schema, _ := parameter["schema"].(map[string]any)
		if schema["type"] != schemaType {
			t.Errorf("%s %s %s parameter %q type = %v, want %s", method, route, location, name, schema["type"], schemaType)
		}
		return
	}
	t.Errorf("%s %s missing %s parameter %q", method, route, location, name)
}

func assertOpenAPIPropertyFormat(t *testing.T, schemas map[string]any, schemaName, propertyName, format string) {
	t.Helper()
	schema, _ := schemas[schemaName].(map[string]any)
	properties, _ := schema["properties"].(map[string]any)
	property, _ := properties[propertyName].(map[string]any)
	if property["format"] != format {
		t.Errorf("%s.%s format = %v, want %s", schemaName, propertyName, property["format"], format)
	}
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
