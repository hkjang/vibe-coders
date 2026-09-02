package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

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
	if got := sanitizeProviderBaseURL("https://azure.example/openai?api-version=2026-01-01"); got != "https://azure.example/openai?api-version=2026-01-01" {
		t.Errorf("safe Azure URL changed: %q", got)
	}
	if got := sanitizeProviderBaseURL("not a URL credential=private"); got != invalidProviderURLDisplay {
		t.Errorf("invalid URL must fail closed, got %q", got)
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
	for _, provider := range payload.Providers {
		if provider.Name == "legacy" {
			legacyPublic = provider
		}
	}
	if legacyPublic.BaseURL != invalidProviderURLDisplay {
		t.Fatalf("legacy provider was not returned safely: %+v", legacyPublic)
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
	audits, err := db.ListAdminAudit(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	foundLegacyAudit := false
	for _, audit := range audits {
		if strings.Contains(audit.BeforeValue+audit.AfterValue, "legacy-path-secret") || strings.Contains(audit.BeforeValue+audit.AfterValue, "query-secret") {
			t.Fatalf("provider audit leaked legacy credentials: %+v", audit)
		}
		if strings.Contains(audit.BeforeValue+audit.AfterValue, `"name":"legacy"`) {
			foundLegacyAudit = true
			if !strings.Contains(audit.BeforeValue, invalidProviderURLDisplay) || !strings.Contains(audit.AfterValue, invalidProviderURLDisplay) {
				t.Fatalf("provider audit did not replace unsafe URL in full: %+v", audit)
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
