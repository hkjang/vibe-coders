package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Editing an existing key is not issuance: an omitted scopes field preserves
// the stored value, while [] removes every grant rather than inheriting its role.
func TestAPIKeyScopeContractPatchEmptyClearsWithoutRoleInheritance(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	const keyID, secret = "scope-contract-edit", "vc_sk_scope_contract_edit"
	if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: keyID, Name: "before", KeyHash: hashProxyKey(secret), Role: "developer",
		Status: "active", Scopes: []string{"chat:completion"},
	}); err != nil {
		t.Fatal(err)
	}
	f.assertChat(t, secret, http.StatusOK)

	f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken,
		`{"name":"renamed"}`, http.StatusOK)
	stored := f.key(t, keyID)
	if stored.Name != "renamed" || !slices.Equal(stored.Scopes, []string{"chat:completion"}) {
		t.Fatal("PATCH with omitted scopes must preserve the existing grants")
	}
	f.assertChat(t, secret, http.StatusOK)

	f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken,
		`{"scopes":null}`, http.StatusOK)
	if !slices.Equal(f.key(t, keyID).Scopes, []string{"chat:completion"}) {
		t.Fatal("PATCH with null scopes must also preserve the existing grants")
	}

	body := f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken,
		`{"scopes":[]}`, http.StatusOK)
	var response struct {
		Role   string   `json:"role"`
		Scopes []string `json:"scopes"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	stored = f.key(t, keyID)
	if response.Role != "developer" || response.Scopes == nil || len(response.Scopes) != 0 ||
		stored.Role != "developer" || len(stored.Scopes) != 0 || stored.Status != "active" {
		t.Fatal("PATCH [] must return and store no grants without changing role or status")
	}
	f.assertChat(t, secret, http.StatusUnauthorized)
	events, err := f.db.ListAuditEvents(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(events, func(event store.AuthEvent) bool {
		return event.APIKeyID == keyID && event.EventType == "scope_denied" && event.Detail == "chat:completion"
	}) {
		t.Fatal("protected chat after PATCH [] must record scope_denied, not inherit developer grants")
	}
}

func TestAPIKeyScopeContractCreateOmittedDefaultsButExplicitEmptyDoesNot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		wantScopes []string
		chatStatus int
	}{
		{
			name: "omitted scopes receive issuance defaults",
			body: `{"name":"default grants","role":"developer"}`,
			wantScopes: []string{"chat:completion", "embeddings:create", "models:read",
				"routing:read", "observability:read", "costs:read", "mcp:use"},
			chatStatus: http.StatusOK,
		},
		{
			name:       "explicit empty scopes receive no grants",
			body:       `{"name":"no grants","role":"developer","scopes":[]}`,
			wantScopes: []string{}, chatStatus: http.StatusUnauthorized,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAPIKeyScopeContractFixture(t)
			body := f.request(t, http.MethodPost, "/admin/api-keys", f.adminToken, tc.body, http.StatusCreated)
			var created struct {
				APIKey struct {
					ID     string   `json:"id"`
					Role   string   `json:"role"`
					Scopes []string `json:"scopes"`
				} `json:"api_key"`
				Secret string `json:"secret"`
			}
			if err := json.Unmarshal(body, &created); err != nil {
				t.Fatal(err)
			}
			if created.APIKey.ID == "" || created.Secret == "" || created.APIKey.Role != "developer" ||
				!slices.Equal(created.APIKey.Scopes, tc.wantScopes) {
				t.Fatal("issuance response does not match omitted versus explicit-empty scopes contract")
			}
			stored := f.key(t, created.APIKey.ID)
			if stored.Role != "developer" || !slices.Equal(stored.Scopes, tc.wantScopes) ||
				stored.KeyHash != hashProxyKey(created.Secret) {
				t.Fatal("issuance must persist its explicit grants and only the secret hash")
			}
			f.assertChat(t, created.Secret, tc.chatStatus)
		})
	}
}

// Older/imported rows can contain a scope this server no longer recognizes.
// Keeping it in a draft must not be confused with permission to resubmit it:
// validation rejects the whole PATCH until the operator explicitly removes it.
func TestAPIKeyScopeContractUnknownScopePatchRejectedWithoutChanges(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	const keyID, unknownScope = "scope-contract-unknown", "fixture:unsupported-scope"
	if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: keyID, Name: "original", KeyHash: hashProxyKey("vc_sk_scope_contract_unknown"),
		Role: "developer", Status: "active", Scopes: []string{"chat:completion", unknownScope},
	}); err != nil {
		t.Fatal(err)
	}
	var roles struct {
		AllScopes []string `json:"all_scopes"`
	}
	if err := json.Unmarshal(f.request(t, http.MethodGet, "/admin/roles", f.adminToken, "", http.StatusOK), &roles); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(roles.AllScopes, "chat:completion") || slices.Contains(roles.AllScopes, unknownScope) {
		t.Fatal("roles endpoint must expose the server's recognized scope catalog")
	}

	// A label-only update does not silently discard or normalize an older scope.
	f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken,
		`{"name":"label updated"}`, http.StatusOK)
	before := f.key(t, keyID)
	if before.Name != "label updated" || !slices.Equal(before.Scopes, []string{"chat:completion", unknownScope}) {
		t.Fatal("omitting scopes must preserve the stored unsupported grant")
	}
	for _, payload := range []string{
		`{"name":"must not change","scopes":["chat:completion","fixture:unsupported-scope"]}`,
		`{"name":"must not change","scopes":["chat:completion","fixture:new-unsupported-scope"]}`,
	} {
		body := f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken, payload, http.StatusBadRequest)
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &failure); err != nil {
			t.Fatal(err)
		}
		if failure.Error.Code != "invalid_scope" || !reflect.DeepEqual(before, f.key(t, keyID)) {
			t.Fatal("unknown scope must return invalid_scope without partially updating the stored key")
		}
	}
	f.request(t, http.MethodPatch, "/admin/api-keys/"+keyID, f.adminToken,
		`{"scopes":["chat:completion"]}`, http.StatusOK)
	after := f.key(t, keyID)
	if after.Name != before.Name || after.Role != before.Role || !slices.Equal(after.Scopes, []string{"chat:completion"}) {
		t.Fatal("explicitly removing the unsupported scope must preserve unrelated key fields")
	}
}

type apiKeyScopeContractFixture struct {
	db            *store.SQLStore
	gateway       *httptest.Server
	adminToken    string
	upstreamCalls atomic.Int64
}

func newAPIKeyScopeContractFixture(t *testing.T) *apiKeyScopeContractFixture {
	t.Helper()
	f := &apiKeyScopeContractFixture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	t.Cleanup(upstream.Close)
	var server *Server
	f.gateway, server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	if !server.cfg.Auth.Enabled {
		t.Fatal("API key scope contract requires AUTH_ENABLED=true")
	}
	f.adminToken = issueLLMScopedTestToken(t, f.db, server, "scope-contract-admin", "super_admin", "",
		[]string{"admin:read", "admin:write"}, time.Now().UTC())
	return f
}

func (f *apiKeyScopeContractFixture) request(t *testing.T, method, path, token, body string, wantStatus int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Vibe-UI", "app")
	res, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != wantStatus {
		t.Fatalf("%s %s returned %d, want %d", method, path, res.StatusCode, wantStatus)
	}
	return data
}

func (f *apiKeyScopeContractFixture) key(t *testing.T, id string) store.APIKeyRecord {
	t.Helper()
	key, found, err := f.db.GetAPIKey(t.Context(), id)
	if err != nil || !found {
		t.Fatalf("stored API key lookup failed: found=%v err=%v", found, err)
	}
	return key
}

func (f *apiKeyScopeContractFixture) assertChat(t *testing.T, secret string, wantStatus int) {
	t.Helper()
	before := f.upstreamCalls.Load()
	// GET /v1/models is intentionally anonymous; use a protected scope endpoint.
	f.request(t, http.MethodPost, "/v1/chat/completions", secret,
		`{"model":"test-model","messages":[{"role":"user","content":"scope contract"}]}`, wantStatus)
	wantCalls := int64(0)
	if wantStatus == http.StatusOK {
		wantCalls = 1
	}
	if got := f.upstreamCalls.Load() - before; got != wantCalls {
		t.Fatalf("chat reached upstream %d times, want %d", got, wantCalls)
	}
}
