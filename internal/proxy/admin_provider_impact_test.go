package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func impactGet(t *testing.T, gateway, ref, token string) (int, providerImpactResponse, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, gateway+"/admin/provider-impact?provider_ref="+url.QueryEscape(ref), nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload providerImpactResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("impact response can be cached")
		}
	}
	return resp.StatusCode, payload, string(body)
}

func assertImpactCount(t *testing.T, section providerImpactSection, count int, status string) {
	t.Helper()
	if section.Status != status || section.MatchedCount == nil || *section.MatchedCount != count {
		t.Fatalf("unexpected section: %+v", section)
	}
	if (status == "complete" && section.CountKind != "exact") || (status == "partial" && section.CountKind != "lower_bound") {
		t.Fatalf("misleading count kind: %+v", section)
	}
}

func TestProviderImpactAggregatesActualConfigurationWithoutUpstream(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	t.Cleanup(upstream.Close)
	server, db, gateway := newAdminModelsTestServer(t, "")
	const name = "configured-provider"
	for _, p := range []store.ProviderConfig{
		{Name: name, BaseURL: upstream.URL, Enabled: true, FailoverGroup: "group"},
		{Name: "peer", BaseURL: upstream.URL, Enabled: true, FailoverGroup: "group"},
		{Name: "disabled-peer", BaseURL: upstream.URL, Enabled: false, FailoverGroup: "group"},
		{Name: "other", BaseURL: upstream.URL, Enabled: true, FailoverGroup: "other"},
	} {
		if err := db.UpsertProvider(t.Context(), p); err != nil {
			t.Fatal(err)
		}
	}
	for _, rule := range []store.RoutingRule{
		{ID: "rule-a", Enabled: true, TargetProvider: name, TargetModel: "model-a"},
		{ID: "rule-b", Enabled: false, TargetProvider: "\u2003" + name + "\u2003", TargetModel: "model-b"},
		{ID: "rule-c", Enabled: true, TargetProvider: "other", TargetModel: "model-c"},
	} {
		if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "agent-a", VirtualModel: "vibe/agent-a", Provider: name, Enabled: true, SystemPrompt: "must-not-leak"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: "team-id", Name: "team-name"}); err != nil {
		t.Fatal(err)
	}
	keys := []store.APIKeyRecord{
		{ID: "all", Team: "team-id", AllowedProviders: nil},
		{ID: "glob", Team: "TEAM-NAME", AllowedProviders: []string{"CONFIGURED-*"}},
		{ID: "blocked", AllowedProviders: []string{"*"}, DeniedProviders: []string{"configured-*"}},
		{ID: "other", AllowedProviders: []string{"other"}},
		{ID: "expired", ExpiresAt: time.Now().UTC().Add(-time.Minute)},
		{ID: "revoked", RevokedAt: time.Now().UTC()},
		{ID: "inactive", Status: "inactive"},
	}
	for _, key := range keys {
		key.KeyHash = key.ID + "-hash"
		if key.Status == "" {
			key.Status = "active"
		}
		if err := db.UpsertAPIKey(t.Context(), key); err != nil {
			t.Fatal(err)
		}
	}
	status, result, body := impactGet(t, gateway.URL, server.providerRef(name), "")
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	assertImpactCount(t, result.RoutingRules, 2, "complete")
	assertImpactCount(t, result.AgentRoutes, 1, "complete")
	assertImpactCount(t, result.FailoverPeers, 1, "complete")
	assertImpactCount(t, result.APIKeys, 2, "complete")
	assertImpactCount(t, result.Teams, 1, "complete")
	if result.FailoverPeers.Items[0].ProviderRef != server.providerRef("peer") || result.FailoverPeers.Scope != "configured_failover_group" {
		t.Fatalf("wrong peer assessment: %+v", result.FailoverPeers)
	}
	if calls.Load() != 0 || result.UpstreamCalls || !result.ReadOnly || result.ConcurrentGuard || result.Consistency != "best_effort" {
		t.Fatal("assessment performed/claimed runtime operations")
	}
	if strings.Contains(body, "must-not-leak") || strings.Contains(body, "-hash") || strings.Contains(body, upstream.URL) {
		t.Fatal("assessment leaked unrelated private configuration")
	}
	for _, omitted := range []string{"full_model_catalog", "model_usage", "pattern_overlap", "runtime_call_success"} {
		if !strings.Contains(body, `"`+omitted+`"`) {
			t.Fatalf("missing unassessed coverage: %s", omitted)
		}
	}
	if _, found, err := db.GetProvider(t.Context(), name); err != nil || !found {
		t.Fatal("read-only assessment changed provider")
	}
}

func TestProviderImpactMasksLegacyPrivateIdentityAndReferences(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	const secret = "sk-ant-legacy-impact-secret"
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: secret, BaseURL: "https://user:password@private.invalid?api_key=private", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: secret, TargetProvider: secret, TargetModel: "Authorization: Bearer sensitive-model", Note: "secret-note"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "agent-private", VirtualModel: secret, Provider: secret, BackingModel: secret, SystemPrompt: "private-prompt"}); err != nil {
		t.Fatal(err)
	}
	status, result, body := impactGet(t, gateway.URL, server.providerRef(secret), "")
	if status != 200 || result.ProviderDisplay != providerNameOmitted {
		t.Fatalf("private provider assessment status=%d display=%q", status, result.ProviderDisplay)
	}
	for _, forbidden := range []string{secret, "sensitive-model", "secret-note", "private-prompt", "private.invalid", "password"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("private field was exposed: %q", forbidden)
		}
	}
	assertImpactCount(t, result.RoutingRules, 1, "complete")
	if !strings.HasPrefix(result.RoutingRules.Items[0].Reference, "impact_") {
		t.Fatal("rule identifier was not opaque")
	}
}

func TestProviderImpactReportsEnvironmentBootstrapWithoutExposingCredential(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "impact-bootstrap.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	const bootstrapSecret = "private-bootstrap-key-do-not-return"
	cfg := testConfig("http://unused.invalid", bootstrapSecret)
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	status, result, body := impactGet(t, gateway.URL, server.providerRef(cfg.Upstream.Provider), "")
	if status != 200 || !result.IsDefault || !result.BootstrapOnRestart || strings.Contains(body, bootstrapSecret) || strings.Contains(body, cfg.Upstream.BaseURL) {
		t.Fatal("environment bootstrap warning missing or private configuration exposed")
	}
}

func TestProviderImpactAuthScopesAndTeamCountsDoNotEscalate(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "impact.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret = true, "impact-test-jwt"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "target", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: "hidden-rule", TargetProvider: "target"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "another-team", Team: "other", KeyHash: "hash", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		role          string
		scopes        []string
		status        int
		routing, keys string
	}{
		{"developer", []string{"routing:read"}, 401, "", ""},
		{"readonly_admin", []string{"admin:read"}, 200, "denied", "complete"},
		{"super_admin", []string{"admin:read", "routing:read"}, 200, "complete", "complete"},
		{"team_admin", []string{"admin:read", "routing:read"}, 200, "complete", "denied"},
	} {
		t.Run(tc.role, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, server, "impact-"+tc.role, tc.role, "own-team", tc.scopes, time.Now().UTC())
			status, result, body := impactGet(t, gateway.URL, server.providerRef("target"), token)
			if status != tc.status {
				t.Fatalf("status=%d body=%s", status, body)
			}
			if status != 200 {
				return
			}
			if result.RoutingRules.Status != tc.routing || result.APIKeys.Status != tc.keys {
				t.Fatalf("scope mismatch: %+v", result)
			}
			for _, section := range []providerImpactSection{result.RoutingRules, result.APIKeys, result.Teams} {
				if section.Status == "denied" && (section.MatchedCount != nil || section.ScannedCount != nil || len(section.Items) != 0 || section.CountKind != "unknown") {
					t.Fatalf("denied section leaked global counts: %+v", section)
				}
			}
		})
	}
	if status, _, _ := impactGet(t, gateway.URL, server.providerRef("target"), ""); status != 401 {
		t.Fatal("unauthenticated assessment allowed")
	}
}

func TestProviderImpactValidatesReferenceAndRejectsMutation(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "admin-token")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "target", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"", "target", "https://private.invalid", "prv_" + strings.Repeat("a", 44)} {
		if status, _, _ := impactGet(t, gateway.URL, ref, "admin-token"); status != 400 {
			t.Fatalf("invalid reference returned %d", status)
		}
	}
	if status, _, _ := impactGet(t, gateway.URL, server.providerRef("missing"), "admin-token"); status != 404 {
		t.Fatal("missing provider not distinguished")
	}
	if status, _, _ := impactGet(t, gateway.URL, server.providerRef("target"), "wrong"); status != 401 {
		t.Fatal("invalid admin token allowed")
	}
	for _, suffix := range []string{"&provider_ref=" + server.providerRef("target"), "&extra=value", "&extra=%zz"} {
		req := httptest.NewRequest(http.MethodGet, "/admin/provider-impact?provider_ref="+server.providerRef("target")+suffix, nil)
		req.Header.Set("Authorization", "Bearer admin-token")
		response := httptest.NewRecorder()
		server.handleProviderImpact(response, req)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("ambiguous or malformed query accepted: %d", response.Code)
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		req, _ := http.NewRequest(method, gateway.URL+"/admin/provider-impact?provider_ref="+server.providerRef("target"), nil)
		req.Header.Set("Authorization", "Bearer admin-token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 405 || resp.Header.Get("Allow") != "GET" {
			t.Fatalf("mutation %s accepted", method)
		}
	}
}

func TestProviderImpactPartialCountsAreConfirmedLowerBounds(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "target", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= providerImpactReadLimit; i++ {
		if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: fmt.Sprintf("rule-%04d", i), TargetProvider: "target"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "oversized", VirtualModel: "vibe/oversized", Provider: "target", BackingModel: strings.Repeat("한", 100)}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "unknown-team", Team: "unknown", KeyHash: "hash", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	status, result, _ := impactGet(t, gateway.URL, server.providerRef("target"), "")
	if status != 200 {
		t.Fatal(status)
	}
	assertImpactCount(t, result.RoutingRules, providerImpactReadLimit, "partial")
	assertImpactCount(t, result.AgentRoutes, 0, "partial")
	assertImpactCount(t, result.APIKeys, 1, "complete")
	assertImpactCount(t, result.Teams, 0, "partial")
}

func TestProviderImpactLookupRejectsIncompleteProviderConfiguration(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "target", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for i := range providerImpactReadLimit {
		if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: fmt.Sprintf("provider-%04d", i), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	status, _, body := impactGet(t, gateway.URL, server.providerRef("target"), "")
	if status != http.StatusServiceUnavailable || !strings.Contains(body, "provider_impact_lookup_unavailable") {
		t.Fatalf("incomplete provider lookup became a missing or assessed provider: %d", status)
	}
}

// Open a raw handle to the same isolated test database for deliberate table
// failures. PostgreSQL uses the existing per-test schema, never public tables.
func impactFailureStore(t *testing.T) (*store.SQLStore, *sql.DB) {
	t.Helper()
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		db := openPostgresTestStore(t, dsn)
		schema := "t" + strings.ToLower(regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(t.Name(), "_"))
		if len(schema) > 55 {
			schema = schema[:55]
		}
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		raw, err := sql.Open("pgx", parsed.String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = raw.Close() })
		return db, raw
	}
	path := filepath.Join(t.TempDir(), "impact.db")
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	return db, raw
}

func TestProviderImpactStorageFailuresAreIndependentUnknownSections(t *testing.T) {
	db, raw := impactFailureStore(t)
	server, gateway := serveAdminModelsTestStore(t, "", db)
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "target", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "agent", VirtualModel: "vibe/agent", Provider: "target"}); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"routing_rules", "api_keys"} {
		if _, err := raw.ExecContext(t.Context(), "DROP TABLE "+table); err != nil {
			t.Fatal(err)
		}
	}
	status, result, _ := impactGet(t, gateway.URL, server.providerRef("target"), "")
	if status != 200 {
		t.Fatal(status)
	}
	assertImpactCount(t, result.AgentRoutes, 1, "complete")
	for _, section := range []providerImpactSection{result.RoutingRules, result.APIKeys, result.Teams} {
		if section.Status != "unavailable" || section.MatchedCount != nil || section.ScannedCount != nil || section.CountKind != "unknown" {
			t.Fatalf("failed section became exact/zero: %+v", section)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := impactGet(t, gateway.URL, server.providerRef("target"), ""); status != 503 {
		t.Fatal("lookup storage failure did not fail closed")
	}
}

func TestProviderImpactUnavailableReferenceProjectionIgnoresPartialData(t *testing.T) {
	section := providerImpactReferences(t.Context(), store.ProviderImpactRead[store.ProviderImpactReference]{Rows: []store.ProviderImpactReference{{ID: "private", Provider: "target"}}, Scanned: 1}, errors.New("private database error"), "target", "direct_provider_references", "routing", func(_, id string) string { return id }, func(v string) (string, error) { return v, nil })
	if section.Status != "unavailable" || section.MatchedCount != nil || len(section.Items) != 0 || strings.Contains(section.Reason, "private") {
		t.Fatalf("failed query exposed partial data: %+v", section)
	}
}

func TestProviderImpactOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	op := spec["paths"].(map[string]any)["/admin/provider-impact"].(map[string]any)["get"].(map[string]any)
	if op["operationId"] != openAPIOperationID("get", "/admin/provider-impact") {
		t.Fatal("missing generated operation")
	}
	response := spec["components"].(map[string]any)["schemas"].(map[string]any)["ProviderImpactResponse"].(map[string]any)
	if len(response["required"].([]string)) != 15 {
		t.Fatal("response contract is incomplete")
	}
	section := providerImpactOpenAPISchemas()["ProviderImpactSection"].(map[string]any)["properties"].(map[string]any)
	if section["matched_count"].(map[string]any)["nullable"] != true {
		t.Fatal("unknown counts cannot be represented")
	}
	for name, value := range map[string]any{
		"ProviderImpactResponse": providerImpactResponse{},
		"ProviderImpactSection":  unavailableProviderImpact("direct_provider_references", "denied", "routing_read_required"),
		"ProviderImpactItem":     providerImpactItem{Reference: "ref", Label: "label", Enabled: true, Model: "model", ProviderRef: "provider", Relation: "direct_binding"},
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		schema := providerImpactOpenAPISchemas()[name].(map[string]any)
		properties := schema["properties"].(map[string]any)
		if len(properties) != len(fields) {
			t.Fatalf("%s schema/runtime field count drift: %d / %d", name, len(properties), len(fields))
		}
		for field := range fields {
			if _, documented := properties[field]; !documented {
				t.Fatalf("%s.%s undocumented", name, field)
			}
		}
		for _, required := range schema["required"].([]string) {
			if _, present := fields[required]; !present {
				t.Fatalf("%s.%s required but omitted", name, required)
			}
		}
		if name == "ProviderImpactSection" && (string(fields["matched_count"]) != "null" || string(fields["scanned_count"]) != "null" || string(fields["items"]) != "[]") {
			t.Fatal("denied counts must serialize as null and items as an empty array")
		}
	}
}

func TestProviderImpactProjectionPreservesPrivacyAndBounds(t *testing.T) {
	const privateName = "sk-ant-provider-impact-private"
	const customSecret = "corp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
	providers := []string{"safe-provider", privateName, "private@example.invalid", " "}
	args := []string{externalCredentialPrefixMarker + "corp_"}
	project, err := providerImpactProjection(t.Context(), providers, args)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"safe-model", privateName, "prefix:" + privateName, "private@example.invalid", customSecret, "Authorization: Bearer sensitive-model", "https://user:password@private.invalid"} {
		got, err := project(value)
		if err != nil {
			t.Fatal(err)
		}
		want := boundedExternalProviderText(value, append(append([]string(nil), providers...), args...)...)
		if got != want {
			t.Fatalf("optimized projection changed safety boundary: got=%q want=%q", got, want)
		}
	}
	got, err := project(strings.Repeat(" ", 256))
	if err != nil || got != providerMetadataOmitted || len(got) > 1024 {
		t.Fatal("replacement expansion bypassed response size boundary")
	}
}

func TestProviderImpactProjectionStopsOnCancellationWithoutPartialCounts(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	project, err := providerImpactProjection(ctx, []string{"safe-provider"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := project("safe-model"); !errors.Is(err, context.Canceled) {
		t.Fatal("projection ignored context cancellation")
	}
	if _, err := providerImpactProjection(ctx, []string{"safe-provider"}, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("identity classification ignored context cancellation")
	}
	ctx, cancel = context.WithCancel(t.Context())
	defer cancel()
	read := store.ProviderImpactRead[store.ProviderImpactReference]{Rows: []store.ProviderImpactReference{{ID: "first", Provider: "target"}, {ID: "second", Provider: "target"}}, Scanned: 2}
	calls := 0
	section := providerImpactReferences(ctx, read, nil, "target", "direct_provider_references", "routing", func(_, id string) string { return id }, func(value string) (string, error) {
		calls++
		if calls == 2 {
			cancel()
		}
		return value, nil
	})
	if section.Status != "unavailable" || section.CountKind != "unknown" || section.MatchedCount != nil || len(section.Items) != 0 || calls != 2 {
		t.Fatalf("canceled assessment exposed incomplete counts: %+v calls=%d", section, calls)
	}
}

func BenchmarkProviderImpactProjectionBoundedConfiguration(b *testing.B) {
	providers := make([]string, providerImpactReadLimit)
	for index := range providers {
		providers[index] = fmt.Sprintf("provider-%04d", index)
	}
	args := []string{externalCredentialPrefixMarker + "vc_sk_", externalCredentialPrefixMarker + "vc_sa_"}
	b.ReportAllocs()
	for b.Loop() {
		project, err := providerImpactProjection(b.Context(), providers, args)
		if err != nil {
			b.Fatal(err)
		}
		for range providerImpactReadLimit * 2 {
			if _, err := project("public-model"); err != nil {
				b.Fatal(err)
			}
		}
	}
}
