package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func providerAppRequest(t *testing.T, method, requestURL string, body any) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, requestURL, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Vibe-UI", "app")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestProviderBaseURLValidationAndSanitization(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "plain HTTPS", raw: "https://provider.example/v1"},
		{name: "Azure api version", raw: "https://azure.example/openai?api-version=2026-01-01"},
		{name: "safe deployment and region", raw: "https://azure.example/openai/deployments/chat-main?api-version=2026-01-01&region=koreacentral"},
		{name: "ordinary credential vocabulary in path", raw: "https://provider.example/docs/tokenization/secret-management/authorization-code"},
		{name: "ordinary sk prefix", raw: "https://provider.example/models/sketch-v2?model=sketch-large"},
		{name: "basic credentials", raw: "https://operator:password@provider.example/v1", wantErr: true},
		{name: "generic key", raw: "https://provider.example/v1?key=private", wantErr: true},
		{name: "AWS credential", raw: "https://provider.example/v1?X-Amz-Credential=private", wantErr: true},
		{name: "authorization", raw: "https://provider.example/v1?auth=private", wantErr: true},
		{name: "signature", raw: "https://provider.example/v1?sig=private", wantErr: true},
		{name: "camel case secret key", raw: "https://provider.example/v1?secretKey=private", wantErr: true},
		{name: "password suffix", raw: "https://provider.example/v1?passwordHash=private", wantErr: true},
		{name: "auth token", raw: "https://provider.example/v1?authToken=private", wantErr: true},
		{name: "credential identifier", raw: "https://provider.example/v1?credentialId=private", wantErr: true},
		{name: "signature version", raw: "https://provider.example/v1?signatureVersion=private", wantErr: true},
		{name: "embedded client secret", raw: "https://provider.example/v1?clientsecretvalue=private", wantErr: true},
		{name: "camel segment secret", raw: "https://provider.example/v1?clientSecretValue=private", wantErr: true},
		{name: "fragment", raw: "https://provider.example/v1#access_token=private", wantErr: true},
		{name: "bearer in decoded query value", raw: "https://provider.example/v1?region=Bearer%20eyJprivatevalue", wantErr: true},
		{name: "OpenAI key in query value", raw: "https://provider.example/v1?deployment=sk-proj-privatecredential", wantErr: true},
		{name: "Anthropic key in query value", raw: "https://provider.example/v1?deployment=sk-ant-api03-privatecredential", wantErr: true},
		{name: "JWT in query value", raw: "https://provider.example/v1?region=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue", wantErr: true},
		{name: "nested token assignment", raw: "https://provider.example/v1?redirect=%2Fcallback%3Faccess_token%3Dprivate", wantErr: true},
		{name: "nested token assignment with slash value", raw: "https://provider.example/v1?redirect=access_token%3D%2Fprivate", wantErr: true},
		{name: "nested URL userinfo", raw: "https://provider.example/v1?redirect=https%3A%2F%2Foperator%3Apassword%40callback.example%2Fdone", wantErr: true},
		{name: "double encoded token key", raw: "https://provider.example/v1?%2574oken=private", wantErr: true},
		{name: "double encoded secret assignment", raw: "https://provider.example/v1?next=%252Fcallback%253Fclient_secret%253Dprivate", wantErr: true},
		{name: "bearer in path", raw: "https://provider.example/proxy/Bearer%20privatecredential", wantErr: true},
		{name: "OpenAI key in path", raw: "https://provider.example/proxy/sk-live-privatecredential", wantErr: true},
		{name: "token assignment in path", raw: "https://provider.example/callback/token=private", wantErr: true},
		{name: "malformed query", raw: "https://provider.example/v1?auth=private;region=kr", wantErr: true},
		{name: "relative", raw: "/provider/v1", wantErr: true},
		{name: "non HTTP", raw: "file:///tmp/provider", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateProviderBaseURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateProviderBaseURL(%q) error = %v, wantErr %v", tt.raw, err, tt.wantErr)
			}
		})
	}

	for _, raw := range []string{
		"https://operator:password@provider.example/v1?api-version=2026-01-01&credential=private&sig=signed#access_token=fragment",
		"https://provider.example/proxy/Bearer%20privatecredential?api-version=2026-01-01",
		"https://provider.example/v1?region=%2Fcallback%3Ftoken%3Dprivate",
	} {
		if got := sanitizeProviderBaseURL(raw); got != invalidProviderURLDisplay {
			t.Errorf("unsafe URL %q must be replaced in full, got %q", raw, got)
		}
	}
	for _, safe := range []string{"vc_sk_model", "vc_sa_preview", "svc-vc_sk_preview"} {
		if providerURLComponentHasCredential(safe) {
			t.Errorf("ordinary provider/model label %q was treated as a credential", safe)
		}
	}
	if got := sanitizeProviderBaseURL("https://azure.example/openai?api-version=2026-01-01"); got != "https://azure.example/openai?api-version=2026-01-01" {
		t.Errorf("safe Azure URL changed: %q", got)
	}
	if got := sanitizeProviderBaseURL("not a URL credential=private"); got != invalidProviderURLDisplay {
		t.Errorf("invalid URL must fail closed, got %q", got)
	}
}

func TestProviderCredentialBoundaryRejectsVendorTokensAndUserinfo(t *testing.T) {
	credentials := []string{
		"ghp_" + strings.Repeat("A", 36),
		"prod_ghp_" + strings.Repeat("A", 36),
		"github_pat_" + strings.Repeat("B", 30),
		"prod_github_pat_" + strings.Repeat("B", 30),
		"AKIA" + strings.Repeat("C", 16),
		"ASIA" + strings.Repeat("D", 16),
		"xoxb-" + strings.Repeat("E", 24),
		"xapp-1-A1234567890-B1234567890-C1234567890",
		"xwfp-" + strings.Repeat("W", 24),
		"xoxe.xoxb-1-1234567890-secretvalue",
		"xoxe-1-abcdefg",
		"AIza" + strings.Repeat("F", 35),
		"prod_AIza" + strings.Repeat("F", 35),
		"vc_sk_" + strings.Repeat("G", 32),
		"prod_vc_sk_" + strings.Repeat("G", 32),
		"vc_sa_" + strings.Repeat("H", 32),
		"Basic ZGVtbzpwYXNzd29yZA==",
		"Basic dTpw",
		"Basic dG9rZW46",
		"Basic OnBhc3N3b3Jk",
		"Basic 6Tp4",
		"Bearer abcdefghijklmnop0",
		"Bearer abc123XYZ890",
		"prod_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
		"postgres://dbuser:dbpass@db.internal/gateway",
		"dbuser:dbpass@db.internal",
		"-----BEGIN PRIVATE KEY-----",
	}
	for _, credential := range credentials {
		t.Run(credential[:min(len(credential), 24)], func(t *testing.T) {
			if !providerURLComponentHasCredential(credential) {
				t.Fatalf("credential was not detected: %q", credential)
			}
			if modelsProviderLabelSafe(credential) {
				t.Fatalf("credential was accepted as a provider label: %q", credential)
			}
			if got := boundedModelsProviderLabel(credential); got != providerNameOmitted {
				t.Fatalf("bounded provider label = %q, want %q", got, providerNameOmitted)
			}
			if got := boundedExternalProviderText("metadata=" + credential); got != providerMetadataOmitted {
				t.Fatalf("external metadata = %q, want %q", got, providerMetadataOmitted)
			}
			projected := boundedExternalProviderText("selected "+credential, credential)
			if strings.Contains(projected, credential) || !strings.Contains(projected, providerNameOmitted) {
				t.Fatalf("raw provider was not safely projected: %q", projected)
			}

			providerURL := "https://provider.example/v1?region=" + url.QueryEscape(credential)
			if err := validateProviderBaseURL(providerURL); err == nil {
				t.Fatalf("credential-bearing provider URL was accepted: %q", providerURL)
			}
			if got := sanitizeProviderBaseURL(providerURL); got != invalidProviderURLDisplay {
				t.Fatalf("sanitized provider URL = %q, want %q", got, invalidProviderURLDisplay)
			}
		})
	}
	for _, unsafeLabel := range []string{"provider-owner@example.com", "dbuser@db.internal"} {
		if modelsProviderLabelSafe(unsafeLabel) {
			t.Fatalf("PII-shaped provider label was accepted: %q", unsafeLabel)
		}
	}

	for _, safe := range []string{
		"github-enterprise",
		"ghp_preview",
		"AKIA-region",
		"xoxb-short",
		"xapp-short",
		"xwfp-short",
		"xoxe-short",
		"AIza-model",
		"Basic auth",
		"Basic authentication",
		"Basic sjoerd",
		"Bearer auth",
		"Bearer authentication",
		"Bearer authentication-service",
		"Bearer authorization-service",
		"Bearer compatible-provider",
		"highp_" + strings.Repeat("A", 36),
		"prefixxoxb-" + strings.Repeat("E", 24),
		"fooAKIA" + strings.Repeat("C", 16) + "bar",
		"postgres-main",
	} {
		if !modelsProviderLabelSafe(safe) {
			t.Errorf("safe provider label was rejected: %q", safe)
		}
	}
	if !providerURLComponentHasCredential(strings.Repeat("x", maxProviderCredentialScanBytes+1)) {
		t.Fatal("oversized provider metadata must fail closed before decoding")
	}
}

func TestConfiguredCredentialPrefixRequiresGeneratedSecretSuffix(t *testing.T) {
	for _, safe := range []string{"corp_model", "my-api_gateway", "api_provider", "corp_" + strings.Repeat("a", 31)} {
		if providerTextContainsConfiguredCredentialPrefix(safe, "corp_") || providerTextContainsConfiguredCredentialPrefix(safe, "api_") {
			t.Fatalf("ordinary label was treated as a configured credential: %q", safe)
		}
	}
	for _, unsafe := range []string{
		"corp_" + strings.Repeat("A", 43),
		"metadata=api_" + strings.Repeat("B", 32),
		"encoded%3Dcorp_" + strings.Repeat("C", 43),
	} {
		prefix := "corp_"
		if strings.Contains(unsafe, "api_") {
			prefix = "api_"
		}
		if !providerTextContainsConfiguredCredentialPrefix(unsafe, prefix) {
			t.Fatalf("configured generated credential was not detected: %q", unsafe)
		}
	}
}

func TestProviderAPIRejectsCredentialURLsAndSanitizesLegacyRows(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("https://default.example", "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)

	legacyLongName := strings.Repeat("p", maxModelsProviderNameBytes+1)
	tooLong := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": legacyLongName, "base_url": "https://new.example", "api_key": "separate-secret", "enabled": true,
	})
	tooLongBody, _ := io.ReadAll(tooLong.Body)
	tooLong.Body.Close()
	if tooLong.StatusCode != http.StatusBadRequest || !strings.Contains(string(tooLongBody), "provider_name_too_long") {
		t.Fatalf("new oversized provider name returned %d: %s", tooLong.StatusCode, tooLongBody)
	}
	if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
		Name: legacyLongName, BaseURL: "https://legacy-long.example", TimeoutMS: 1_000, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	legacyEdit := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": legacyLongName, "base_url": "https://legacy-long.example", "timeout_ms": 2_000, "enabled": false,
	})
	legacyEditBody, _ := io.ReadAll(legacyEdit.Body)
	legacyEdit.Body.Close()
	if legacyEdit.StatusCode != http.StatusOK {
		t.Fatalf("legacy oversized provider edit returned %d: %s", legacyEdit.StatusCode, legacyEditBody)
	}
	for _, unsafeName := range []string{"comma,name", "line\r\nbreak", "sk-ant-provider-secret-value"} {
		unsafeCreate := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": unsafeName, "base_url": "https://new.example", "api_key": "separate-secret", "enabled": true,
		})
		unsafeBody, _ := io.ReadAll(unsafeCreate.Body)
		unsafeCreate.Body.Close()
		if unsafeCreate.StatusCode != http.StatusBadRequest || !strings.Contains(string(unsafeBody), "provider_name_invalid") {
			t.Fatalf("unsafe provider name %q returned %d: %s", unsafeName, unsafeCreate.StatusCode, unsafeBody)
		}
	}
	for _, reservedName := range []string{"*", "vibe", "aggregate", "[provider-name-omitted]"} {
		reservedCreate := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": reservedName, "base_url": "https://new.example", "enabled": true,
		})
		reservedBody, _ := io.ReadAll(reservedCreate.Body)
		reservedCreate.Body.Close()
		if reservedCreate.StatusCode != http.StatusBadRequest || !strings.Contains(string(reservedBody), "provider_name_reserved") {
			t.Fatalf("reserved provider name %q returned %d: %s", reservedName, reservedCreate.StatusCode, reservedBody)
		}
	}
	if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
		Name: "vibe", BaseURL: "https://legacy-reserved.example", TimeoutMS: 1_000, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	legacyReservedEdit := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "vibe", "base_url": "https://legacy-reserved.example", "timeout_ms": 2_000, "enabled": false,
	})
	legacyReservedBody, _ := io.ReadAll(legacyReservedEdit.Body)
	legacyReservedEdit.Body.Close()
	if legacyReservedEdit.StatusCode != http.StatusOK {
		t.Fatalf("legacy reserved provider edit returned %d: %s", legacyReservedEdit.StatusCode, legacyReservedBody)
	}
	legacyUnsafeName := "sk-ant-legacy-provider-secret"
	if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
		Name: legacyUnsafeName, BaseURL: "https://legacy-unsafe.example", TimeoutMS: 1_000, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	legacyUnsafeEdit := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": legacyUnsafeName, "base_url": "https://legacy-unsafe.example", "timeout_ms": 2_000, "enabled": false,
	})
	legacyUnsafeBody, _ := io.ReadAll(legacyUnsafeEdit.Body)
	legacyUnsafeEdit.Body.Close()
	if legacyUnsafeEdit.StatusCode != http.StatusOK {
		t.Fatalf("legacy unsafe provider edit returned %d: %s", legacyUnsafeEdit.StatusCode, legacyUnsafeBody)
	}
	appUnsafeEdit := providerAppRequest(t, http.MethodPost, proxy.URL+"/admin/providers", map[string]any{
		"name": legacyUnsafeName, "base_url": "https://legacy-unsafe.example", "timeout_ms": 3_000, "enabled": false,
	})
	appUnsafeEditBody, _ := io.ReadAll(appUnsafeEdit.Body)
	appUnsafeEdit.Body.Close()
	if appUnsafeEdit.StatusCode != http.StatusOK || strings.Contains(string(appUnsafeEditBody), legacyUnsafeName) {
		t.Fatalf("app provider edit did not redact unsafe name: status=%d body=%s", appUnsafeEdit.StatusCode, appUnsafeEditBody)
	}
	var appUnsafeEditPayload struct {
		Provider store.ProviderPublic `json:"provider"`
	}
	if err := json.Unmarshal(appUnsafeEditBody, &appUnsafeEditPayload); err != nil {
		t.Fatal(err)
	}
	if appUnsafeEditPayload.Provider.Name != "[provider-name-omitted]" || appUnsafeEditPayload.Provider.ProviderRef != server.providerRef(legacyUnsafeName) {
		t.Fatalf("app provider edit projection = %+v", appUnsafeEditPayload.Provider)
	}

	for _, raw := range []string{
		"https://operator:password@provider.example/v1",
		"https://provider.example/v1?subscription-key=private",
		"https://provider.example/v1?region=Bearer%20privatecredential",
		"https://provider.example/proxy/sk-proj-privatecredential",
		"https://provider.example/callback/token=private",
		"https://provider.example/v1#token=private",
	} {
		response := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": "unsafe", "base_url": raw, "api_key": "separate-secret", "enabled": true,
		})
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "invalid_base_url") {
			t.Fatalf("credential URL %q returned %d: %s", raw, response.StatusCode, body)
		}
	}

	safeURL := "https://azure.example/openai?api-version=2026-01-01"
	response := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "azure", "base_url": safeURL, "api_key": "separate-secret", "enabled": true,
	})
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("safe Azure URL returned %d: %s", response.StatusCode, body)
	}
	response.Body.Close()

	legacyRaw := "https://legacy.example/proxy/Bearer%20legacy-path-secret?api-version=2026-01-01&region=%2Fcallback%3Ftoken%3Dquery-secret"
	if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
		Name: "legacy", BaseURL: legacyRaw, TimeoutMS: 5_000, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	listed, err := http.Get(proxy.URL + "/admin/providers")
	if err != nil {
		t.Fatal(err)
	}
	listedBody, _ := io.ReadAll(listed.Body)
	listed.Body.Close()
	if listed.StatusCode != http.StatusOK || listed.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("provider list status/cache = %d/%q", listed.StatusCode, listed.Header.Get("Cache-Control"))
	}
	for _, secret := range []string{"legacy.example", "legacy-path-secret", "query-secret"} {
		if strings.Contains(string(listedBody), secret) {
			t.Errorf("provider list leaked %q: %s", secret, listedBody)
		}
	}
	var payload struct {
		Providers []store.ProviderPublic `json:"providers"`
	}
	if err := json.Unmarshal(listedBody, &payload); err != nil {
		t.Fatal(err)
	}
	var legacyPublic store.ProviderPublic
	legacyUnsafeFound := false
	for _, provider := range payload.Providers {
		if provider.Name == "legacy" {
			legacyPublic = provider
		}
		if provider.Name == legacyUnsafeName {
			legacyUnsafeFound = true
		}
	}
	if !legacyUnsafeFound {
		t.Fatal("legacy provider list no longer preserves the raw name needed by the legacy editor")
	}

	appListed := providerAppRequest(t, http.MethodGet, proxy.URL+"/admin/providers", nil)
	appListedBody, _ := io.ReadAll(appListed.Body)
	appListed.Body.Close()
	if appListed.StatusCode != http.StatusOK || strings.Contains(string(appListedBody), legacyUnsafeName) {
		t.Fatalf("app provider list did not redact unsafe name: status=%d body=%s", appListed.StatusCode, appListedBody)
	}
	var appPayload struct {
		Providers []store.ProviderPublic `json:"providers"`
	}
	if err := json.Unmarshal(appListedBody, &appPayload); err != nil {
		t.Fatal(err)
	}
	appUnsafeFound := false
	appSafeFound := false
	appLegacyReservedFound := false
	for _, provider := range appPayload.Providers {
		switch provider.ProviderRef {
		case server.providerRef(legacyUnsafeName):
			appUnsafeFound = provider.Name == "[provider-name-omitted]"
		case server.providerRef("azure"):
			appSafeFound = provider.Name == "azure"
		case server.providerRef("vibe"):
			appLegacyReservedFound = provider.Name == "vibe" && provider.ProviderRef != server.systemProviderRef("vibe")
		}
	}
	if !appUnsafeFound || !appSafeFound || !appLegacyReservedFound {
		t.Fatalf("app provider projections did not preserve safe labels and opaque identity: %+v", appPayload.Providers)
	}
	if legacyPublic.BaseURL != invalidProviderURLDisplay {
		t.Fatalf("legacy provider was not returned safely: %+v", legacyPublic)
	}
	if legacyPublic.ProviderRef != "" || strings.Contains(string(listedBody), `"provider_ref"`) {
		t.Fatalf("legacy provider response gained app-only provider_ref: %s", listedBody)
	}

	// An unrelated update from the Legacy UI sends the redacted representation
	// back. It must neither corrupt the URL nor expose it in the response/audit.
	updated := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "legacy", "base_url": legacyPublic.BaseURL, "timeout_ms": 7_000, "enabled": false,
	})
	updatedBody, _ := io.ReadAll(updated.Body)
	updated.Body.Close()
	if updated.StatusCode != http.StatusOK {
		t.Fatalf("redacted legacy update returned %d: %s", updated.StatusCode, updatedBody)
	}
	if strings.Contains(string(updatedBody), "legacy-path-secret") || strings.Contains(string(updatedBody), "query-secret") {
		t.Fatalf("provider update response leaked legacy credentials: %s", updatedBody)
	}
	stored, found, err := db.GetProvider(context.Background(), "legacy")
	if err != nil || !found || stored.BaseURL != legacyRaw || stored.TimeoutMS != 7_000 || stored.Enabled {
		t.Fatalf("redacted legacy update corrupted provider: found=%v err=%v provider=%+v", found, err, stored)
	}
	audits, err := db.ListAdminAudit(context.Background(), 50)
	if err != nil {
		t.Fatal(err)
	}
	foundLegacyAudit := false
	for _, audit := range audits {
		if strings.Contains(audit.BeforeValue+audit.AfterValue, `"provider_ref"`) {
			t.Fatalf("provider audit must not persist a rotating provider_ref: %+v", audit)
		}
		if strings.Contains(audit.BeforeValue+audit.AfterValue, legacyUnsafeName) {
			t.Fatalf("provider audit leaked unsafe legacy name: %+v", audit)
		}
		if strings.Contains(audit.BeforeValue+audit.AfterValue, "legacy-path-secret") || strings.Contains(audit.BeforeValue+audit.AfterValue, "query-secret") {
			t.Fatalf("provider audit leaked legacy credentials: %+v", audit)
		}
		if strings.Contains(audit.BeforeValue+audit.AfterValue, `"name":"legacy"`) {
			foundLegacyAudit = true
			if !strings.Contains(audit.BeforeValue, invalidProviderURLDisplay) || !strings.Contains(audit.AfterValue, invalidProviderURLDisplay) {
				t.Fatalf("provider audit did not replace unsafe URL in full: %+v", audit)
			}
		}
		if strings.Contains(audit.BeforeValue+audit.AfterValue, `"name":"[provider-name-omitted]"`) {
			if strings.Contains(audit.BeforeValue+audit.AfterValue, legacyUnsafeName) {
				t.Fatalf("unsafe provider audit label leaked its raw identity: %+v", audit)
			}
		}
	}
	if !foundLegacyAudit {
		t.Fatal("legacy provider audit was not recorded")
	}
}

func TestChatProviderMetadataNeverReflectsLegacyCredentialURL(t *testing.T) {
	metadata := providerMetadata(store.ProviderPublic{
		BaseURL: "https://provider.example/proxy/sk-proj-privatecredential?api-version=2026-01-01",
	})
	if metadata["base_url"] != invalidProviderURLDisplay {
		t.Fatalf("chat target metadata base_url = %v, want fail-closed placeholder", metadata["base_url"])
	}
}
