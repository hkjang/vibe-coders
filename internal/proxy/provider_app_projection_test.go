package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func newProviderAppProjectionServer(t *testing.T) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "projection.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("https://unused.invalid", "")
	cfg.Auth.APIKeyPrefix = "corp_"
	cfg.Auth.ServiceKeyPrefix = "svc%41_"
	cfg.Auth.HistoricalKeyPrefixes = []string{"old_", "old%42_", "MiXeD_", "tenant%key_"}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	return server, db, gateway
}

func readProviderProjectionResponse(t *testing.T, response *http.Response, wantStatus int) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("could not read provider response")
	}
	if response.StatusCode != wantStatus {
		t.Fatalf("provider response status = %d, want %d", response.StatusCode, wantStatus)
	}
	return body
}

func assertProviderProjectionNoSecrets(t *testing.T, data string, secrets ...string) {
	t.Helper()
	for index, secret := range secrets {
		if strings.Contains(data, secret) || strings.Contains(data, url.QueryEscape(secret)) || strings.Contains(data, url.PathEscape(secret)) {
			t.Errorf("public provider projection leaked synthetic credential case %d", index)
		}
	}
}

func listedProviderProjection(t *testing.T, body []byte, ref string) store.ProviderPublic {
	t.Helper()
	var result struct {
		Providers []store.ProviderPublic `json:"providers"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal("invalid provider list response")
	}
	for _, provider := range result.Providers {
		if provider.ProviderRef == ref {
			return provider
		}
	}
	t.Fatal("provider opaque identity missing from projection")
	return store.ProviderPublic{}
}

func TestProviderAppProjectionPreservesMaskedMetadataAndURL(t *testing.T) {
	server, db, gateway := newProviderAppProjectionServer(t)
	modelSecret := "corp_" + strings.Repeat("M", 40)
	groupSecret := "old_" + strings.Repeat("G", 40)
	urlSecret := "old_" + strings.Repeat("U", 40)
	const keySecret = "synthetic-provider-projection-key"
	before := store.ProviderConfig{
		Name: "public-projection", BaseURL: "https://provider.invalid/v1?value=" + urlSecret,
		ModelPatterns: "model-* / " + modelSecret, FailoverGroup: "group-" + groupSecret,
		Enabled: true, TimeoutMS: 30000, Priority: 21,
	}
	addAdminModelsProvider(t, server, db, before, keySecret)
	storedBefore, _, err := db.GetProvider(t.Context(), before.Name)
	if err != nil {
		t.Fatal(err)
	}
	list := readProviderProjectionResponse(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/providers", nil), 200)
	assertProviderProjectionNoSecrets(t, string(list), modelSecret, groupSecret, urlSecret, keySecret)
	public := listedProviderProjection(t, list, server.providerRef(before.Name))
	if public.BaseURL != invalidProviderURLDisplay || public.ModelPatterns != providerMetadataOmitted || public.FailoverGroup != providerMetadataOmitted {
		t.Error("stored credential metadata was not fully masked")
	}
	payload := map[string]any{
		"name": before.Name, "base_url": public.BaseURL, "model_patterns": public.ModelPatterns,
		"failover_group": public.FailoverGroup, "enabled": false, "timeout_ms": 41000,
	}
	updated := readProviderProjectionResponse(t, providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers", payload), 200)
	assertProviderProjectionNoSecrets(t, string(updated), modelSecret, groupSecret, urlSecret, keySecret)
	var result struct {
		Provider store.ProviderPublic `json:"provider"`
	}
	if err := json.Unmarshal(updated, &result); err != nil {
		t.Fatal("invalid provider update response")
	}
	if result.Provider.ProviderRef != public.ProviderRef || result.Provider.ModelPatterns != public.ModelPatterns || result.Provider.FailoverGroup != public.FailoverGroup || result.Provider.BaseURL != public.BaseURL {
		t.Error("POST projection does not match GET projection or opaque identity")
	}
	stored, found, err := db.GetProvider(t.Context(), before.Name)
	if err != nil || !found {
		t.Fatal("provider missing after update")
	}
	if stored.BaseURL != before.BaseURL || stored.ModelPatterns != before.ModelPatterns || stored.FailoverGroup != before.FailoverGroup {
		t.Error("unchanged public projections replaced stored original fields")
	}
	if stored.EncryptedAPIKey != storedBefore.EncryptedAPIKey || stored.Priority != before.Priority || stored.TimeoutMS != 41000 || stored.Enabled {
		t.Error("unrelated edit changed secret/priority or lost requested timeout/status")
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 1 || audits[0].Action != "provider.upsert" {
		t.Fatal("provider upsert audit missing")
	}
	assertProviderProjectionNoSecrets(t, audits[0].BeforeValue+audits[0].AfterValue, modelSecret, groupSecret, urlSecret, keySecret)
	if strings.Contains(audits[0].BeforeValue+audits[0].AfterValue, "provider_ref") {
		t.Error("audit persisted rotating opaque identity")
	}

	// Different values remain an explicit edit; empty metadata still means clear.
	payload["base_url"] = "https://replacement.invalid/v1"
	payload["model_patterns"] = " new-public-* "
	payload["failover_group"] = ""
	readProviderProjectionResponse(t, providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers", payload), 200)
	stored, _, err = db.GetProvider(t.Context(), before.Name)
	if err != nil || stored.BaseURL != payload["base_url"] || stored.ModelPatterns != "new-public-*" || stored.FailoverGroup != "" {
		t.Error("explicit replacement/clear stopped following existing semantics")
	}
}

func TestProviderAppProjectionNewMetadataIsNotReflected(t *testing.T) {
	server, db, gateway := newProviderAppProjectionServer(t)
	modelSecret := "svc%41_" + strings.Repeat("A", 40)
	groupSecret := "old%42_" + strings.Repeat("B", 40)
	body := readProviderProjectionResponse(t, providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers", map[string]any{
		"name": "created-public", "base_url": "https://safe.invalid/v1", "model_patterns": modelSecret, "failover_group": groupSecret,
	}), 200)
	assertProviderProjectionNoSecrets(t, string(body), modelSecret, groupSecret)
	var result struct {
		Provider store.ProviderPublic `json:"provider"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal("invalid POST response")
	}
	if result.Provider.ProviderRef != server.providerRef("created-public") || result.Provider.ModelPatterns != providerMetadataOmitted || result.Provider.FailoverGroup != providerMetadataOmitted {
		t.Error("new metadata response is not safely projected")
	}
	stored, found, err := db.GetProvider(t.Context(), "created-public")
	if err != nil || !found || stored.ModelPatterns != modelSecret || stored.FailoverGroup != groupSecret {
		t.Error("explicit new metadata did not keep existing write contract")
	}
}

func TestProviderAppProjectionCredentialURLBoundaries(t *testing.T) {
	server, db, gateway := newProviderAppProjectionServer(t)
	for _, tc := range []struct{ name, secret, raw string }{
		{"runtime-host", "corp_" + strings.Repeat("A", 40), "https://%s.example.invalid/v1"},
		{"historical-query", "old_" + strings.Repeat("B", 40), "https://safe.invalid/v1?value=%s"},
		{"percent-service-path", "svc%41_" + strings.Repeat("C", 40), "https://safe.invalid/%s/v1"},
		{"percent-history-query", "old%42_" + strings.Repeat("D", 40), "https://safe.invalid/v1?value=%s"},
		{"vendor-host", "sk-proj-abcdefgh", "https://%s.example.invalid/v1"},
		{"case-preserved-host", "MiXeD_" + strings.Repeat("E", 40), "https://%s.example.invalid/v1"},
		{"encoded-percent-host", "svc%2541_" + strings.Repeat("F", 40), "https://%s.example.invalid/v1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := strings.Replace(tc.raw, "%s", tc.secret, 1)
			addAdminModelsProvider(t, server, db, store.ProviderConfig{Name: tc.name, BaseURL: raw, Enabled: true}, "")
			body := readProviderProjectionResponse(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/providers", nil), 200)
			assertProviderProjectionNoSecrets(t, string(body), tc.secret)
			public := listedProviderProjection(t, body, server.providerRef(tc.name))
			if public.BaseURL != invalidProviderURLDisplay {
				t.Error("credential URL escaped app projection")
			}
			updated := readProviderProjectionResponse(t, providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers", map[string]any{
				"name": tc.name, "base_url": invalidProviderURLDisplay, "enabled": false,
			}), 200)
			assertProviderProjectionNoSecrets(t, string(updated), tc.secret)
			stored, found, err := db.GetProvider(t.Context(), tc.name)
			if err != nil || !found || stored.BaseURL != raw || stored.Enabled {
				t.Error("masked URL update did not preserve existing original")
			}
			response := providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers", map[string]any{"name": "new-" + tc.name, "base_url": raw})
			rejected := readProviderProjectionResponse(t, response, 400)
			assertProviderProjectionNoSecrets(t, string(rejected), tc.secret)
		})
	}
}

func TestProviderAppURLProjectionEncodingLayers(t *testing.T) {
	server, _, _ := newProviderAppProjectionServer(t)
	for _, tc := range []struct{ name, value string }{
		{"encoded-path-with-literal-percent", "/100%25/tenant%2525key_" + strings.Repeat("A", 40)},
		{"encoded-query-key", "/v1?corp%255f" + strings.Repeat("B", 40) + "=ordinary"},
		{"deep-encoded-query", "/v1?value=old%252525255f" + strings.Repeat("C", 40)},
		{"encoded-vendor-with-literal-percent", "/100%25/sk%252dproj%252dabcdefgh"},
		{"double-encoded-percent-prefix", "/v1?value=svc%252541_" + strings.Repeat("D", 40)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := "https://safe.invalid" + tc.value
			if server.validateProviderBaseURLForApp(value) == nil || server.sanitizeProviderBaseURLForConfig(value) != invalidProviderURLDisplay {
				t.Error("encoded credentials escaped configured URL boundary")
			}
		})
	}
	for _, value := range []string{
		"https://corp_model.invalid/v1?api-version=2026-01-01&region=korea",
		"https://safe.invalid/models/old_preview",
		"https://safe.invalid/100%25/v1?deployment=chat-public",
		"https://safe.invalid/v1?value=svc%2541_short",
	} {
		if server.validateProviderBaseURLForApp(value) != nil || server.sanitizeProviderBaseURLForConfig(value) != value {
			t.Error("ordinary URL changed at configured projection boundary")
		}
	}
}

func TestProviderAppMetadataPreservationUsesExactCurrentFieldProjection(t *testing.T) {
	for _, tc := range []struct{ name, submitted, original, public, want string }{
		{"masked-round-trip", providerMetadataOmitted, "stored-original", providerMetadataOmitted, "stored-original"},
		{"explicit-empty", "", "stored-original", providerMetadataOmitted, ""},
		{"explicit-whitespace", "  ", "stored-original", providerMetadataOmitted, ""},
		{"different-value", " changed ", "stored-original", providerMetadataOmitted, "changed"},
		{"not-exact-projection", " " + providerMetadataOmitted, "stored-original", providerMetadataOmitted, providerMetadataOmitted},
		{"literal-unmasked-placeholder", providerMetadataOmitted, providerMetadataOmitted, providerMetadataOmitted, providerMetadataOmitted},
		{"another-fields-placeholder", providerMetadataOmitted, "public-value", "public-value", providerMetadataOmitted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if providerAppMetadataWriteValue(tc.submitted, tc.original, tc.public) != tc.want {
				t.Error("metadata preservation broadened exact current-field match")
			}
		})
	}
}

func TestProviderAppProjectionPreservesScopesAndUnsafeNameIdentity(t *testing.T) {
	gateway, server, db := scopedSettingsSecurityServer(t, "https://unused.invalid")
	name := "vc_sk_" + strings.Repeat("N", 40)
	metadata := "vc_sa_" + strings.Repeat("M", 40)
	addAdminModelsProvider(t, server, db, store.ProviderConfig{Name: name, BaseURL: "https://safe.invalid/v1", ModelPatterns: metadata, FailoverGroup: metadata, Enabled: true}, "")
	for _, tc := range []struct {
		role   string
		scopes []string
		method string
		status int
	}{
		{"readonly_admin", []string{"admin:read"}, http.MethodGet, 200},
		{"readonly_admin", []string{"admin:read"}, http.MethodPost, 401},
		{"developer", []string{"routing:read"}, http.MethodGet, 401},
		{"super_admin", []string{"admin:read", "admin:write"}, http.MethodPost, 200},
	} {
		t.Run(tc.role+tc.method, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, server, "projection-"+tc.role+tc.method, tc.role, "", tc.scopes, time.Now().UTC())
			payload, err := json.Marshal(map[string]any{"name": name, "base_url": "https://safe.invalid/v1", "model_patterns": providerMetadataOmitted, "failover_group": providerMetadataOmitted, "enabled": false})
			if err != nil {
				t.Fatal("could not encode synthetic edit")
			}
			request, err := http.NewRequest(tc.method, gateway.URL+"/admin/providers", strings.NewReader(string(payload)))
			if err != nil {
				t.Fatal("could not create synthetic request")
			}
			request.Header.Set("Authorization", "Bearer "+token)
			request.Header.Set("X-Vibe-UI", "app")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal("provider request failed")
			}
			body := readProviderProjectionResponse(t, response, tc.status)
			assertProviderProjectionNoSecrets(t, string(body), name, metadata)
			if tc.status == 200 && !strings.Contains(string(body), server.providerRef(name)) {
				t.Error("opaque provider identity missing")
			}
		})
	}
	stored, found, err := db.GetProvider(t.Context(), name)
	if err != nil || !found || stored.Name != name || stored.ModelPatterns != metadata || stored.FailoverGroup != metadata || stored.Enabled {
		t.Error("authorized exact-name update lost internal identity or preserved metadata")
	}
	// Omitting a metadata field retains the pre-existing full-upsert clear rule.
	token := issueLLMScopedTestToken(t, db, server, "projection-omitted", "super_admin", "", []string{"admin:read", "admin:write"}, time.Now().UTC())
	requestBody, _ := json.Marshal(map[string]any{"name": name, "base_url": "https://safe.invalid/v1"})
	request, _ := http.NewRequest(http.MethodPost, gateway.URL+"/admin/providers", strings.NewReader(string(requestBody)))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Vibe-UI", "app")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal("omitted-field request failed")
	}
	readProviderProjectionResponse(t, response, 200)
	stored, _, err = db.GetProvider(t.Context(), name)
	if err != nil || stored.ModelPatterns != "" || stored.FailoverGroup != "" {
		t.Error("omitted fields gained partial-update semantics")
	}
}

func TestProviderAppProjectionDoesNotAlterLegacyMetadataContract(t *testing.T) {
	server, db, gateway := newProviderAppProjectionServer(t)
	secret := "corp_" + strings.Repeat("L", 40)
	row := store.ProviderConfig{Name: "legacy-public", BaseURL: "https://safe.invalid/v1", ModelPatterns: secret, FailoverGroup: secret, Enabled: true}
	addAdminModelsProvider(t, server, db, row, "")
	response, err := http.Get(gateway.URL + "/admin/providers")
	if err != nil {
		t.Fatal(err)
	}
	body := readProviderProjectionResponse(t, response, 200)
	if !strings.Contains(string(body), secret) || strings.Contains(string(body), "provider_ref") {
		t.Error("legacy GET metadata/identity contract changed")
	}
	body = readProviderProjectionResponse(t, postJSON(t, gateway.URL+"/admin/providers", "", map[string]any{
		"name": row.Name, "base_url": row.BaseURL, "model_patterns": providerMetadataOmitted, "failover_group": providerMetadataOmitted,
	}), 200)
	if strings.Contains(string(body), "provider_ref") {
		t.Error("legacy POST gained app-only reference")
	}
	stored, found, err := db.GetProvider(t.Context(), row.Name)
	if err != nil || !found || stored.ModelPatterns != providerMetadataOmitted || stored.FailoverGroup != providerMetadataOmitted {
		t.Error("app preservation leaked into legacy literal-value writes")
	}
}
