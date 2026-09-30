//go:build linux

package proxy

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

// This is only the external model boundary. The browser still uses the real
// gateway routes, authorization, settings, key storage and audit pipeline.
// Count only synthetic model identifiers; never retain bodies or credentials.
type browserAccessUpstream struct {
	server           *httptest.Server
	calls            atomic.Int64
	deniedModelCalls atomic.Int64
}

func newBrowserAccessUpstream(t *testing.T) *browserAccessUpstream {
	t.Helper()
	f := &browserAccessUpstream{}
	f.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var request struct {
			Model string `json:"model"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&request) != nil ||
			(request.Model != "browser-access-model" && request.Model != "browser-access-denied-model") {
			http.Error(w, "invalid synthetic model request", http.StatusBadRequest)
			return
		}
		f.calls.Add(1)
		if request.Model == "browser-access-denied-model" {
			f.deniedModelCalls.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"synthetic-access-response","object":"chat.completion","model":"browser-access-model","choices":[{"index":0,"message":{"role":"assistant","content":"synthetic access response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	f.server.Config.ErrorLog = log.New(io.Discard, "", 0)
	f.server.Start()
	t.Cleanup(f.server.Close)
	return f
}

func browserAccessLogin(t *testing.T, h *browserAuthHarness, readonly bool) string {
	t.Helper()
	email, password := "admin-browser@example.invalid", h.adminPassword
	if readonly {
		email, password = "readonly-browser@example.invalid", h.readonlyPassword
	}
	response := browserAuthJSON(t, h.gateway.Client(), http.MethodPost, h.gateway.URL+"/auth/login", "",
		map[string]string{"email": email, "password": password}, http.StatusOK)
	token, _ := response["access_token"].(string)
	if token == "" {
		t.Fatal("synthetic access session was not issued")
	}
	return token
}

func browserAccessIssue(t *testing.T, h *browserAuthHarness, token string) (string, string) {
	t.Helper()
	response := browserAuthJSON(t, h.gateway.Client(), http.MethodPost, h.gateway.URL+"/admin/api-keys", token,
		map[string]string{"name": "synthetic access key", "role": "developer"}, http.StatusCreated)
	key, _ := response["api_key"].(map[string]any)
	id, _ := key["id"].(string)
	secret, _ := response["secret"].(string)
	if id == "" || secret == "" {
		t.Fatal("synthetic key issuance response was incomplete")
	}
	return id, secret
}

func TestAuthBrowserFixtureAPIKeyPublicStorageAndScopeAuthority(t *testing.T) {
	h := newBrowserAuthHarness(t)
	token := browserAccessLogin(t, h, false)
	id, secret := browserAccessIssue(t, h, token)
	stored, found, err := h.db.GetAPIKey(t.Context(), id)
	if err != nil || !found || stored.KeyHash != hashProxyKey(secret) || stored.KeyHash == secret ||
		!slices.Contains(stored.Scopes, "chat:completion") {
		t.Fatal("issued key must persist only its hash and issuance default grants")
	}
	public := browserAuthJSON(t, h.gateway.Client(), http.MethodGet, h.gateway.URL+"/admin/api-keys", token, nil, http.StatusOK)
	encoded, err := json.Marshal(public)
	if err != nil || strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), stored.KeyHash) ||
		strings.Contains(string(encoded), `"secret"`) || strings.Contains(string(encoded), `"key_hash"`) || strings.Contains(string(encoded), `"KeyHash"`) {
		t.Fatal("public key listing exposed a credential field or value")
	}
	chat := func(model string, status int) {
		t.Helper()
		browserAuthJSON(t, h.gateway.Client(), http.MethodPost, h.gateway.URL+"/v1/chat/completions", secret,
			map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "synthetic permission check"}}}, status)
	}
	// Both model identifiers work when authorized; the denied model is not an
	// intentionally invalid request that could disguise a missing auth check.
	chat("browser-access-model", http.StatusOK)
	chat("browser-access-denied-model", http.StatusOK)
	before, deniedBefore := h.upstream.calls.Load(), h.upstream.deniedModelCalls.Load()
	browserAuthJSON(t, h.gateway.Client(), http.MethodPatch, h.gateway.URL+"/admin/api-keys/"+id, token,
		map[string]any{"scopes": []string{}}, http.StatusOK)
	chat("browser-access-denied-model", http.StatusUnauthorized)
	if h.upstream.calls.Load() != before || h.upstream.deniedModelCalls.Load() != deniedBefore {
		t.Fatal("a key without grants reached the synthetic upstream")
	}
	browserAuthJSON(t, h.gateway.Client(), http.MethodPatch, h.gateway.URL+"/admin/api-keys/"+id, token,
		map[string]any{"scopes": []string{"chat:completion"}}, http.StatusOK)
	chat("browser-access-model", http.StatusOK)
}

func TestAuthBrowserFixtureReadonlyCannotIssueOrChangeKey(t *testing.T) {
	h := newBrowserAuthHarness(t)
	id, _ := browserAccessIssue(t, h, browserAccessLogin(t, h, false))
	before, found, err := h.db.GetAPIKey(t.Context(), id)
	if err != nil || !found {
		t.Fatal("synthetic key record was unavailable")
	}
	token := browserAccessLogin(t, h, true)
	beforeList := browserAuthJSON(t, h.gateway.Client(), http.MethodGet, h.gateway.URL+"/admin/api-keys", token, nil, http.StatusOK)
	browserAuthJSON(t, h.gateway.Client(), http.MethodPost, h.gateway.URL+"/admin/api-keys", token,
		map[string]string{"name": "must not be created"}, http.StatusUnauthorized)
	browserAuthJSON(t, h.gateway.Client(), http.MethodPatch, h.gateway.URL+"/admin/api-keys/"+id, token,
		map[string]any{"name": "must not change", "scopes": []string{}}, http.StatusUnauthorized)
	after, found, err := h.db.GetAPIKey(t.Context(), id)
	if err != nil || !found || !reflect.DeepEqual(before, after) {
		t.Fatal("denied key mutation changed stored data")
	}
	afterList := browserAuthJSON(t, h.gateway.Client(), http.MethodGet, h.gateway.URL+"/admin/api-keys", token, nil, http.StatusOK)
	if !reflect.DeepEqual(beforeList, afterList) {
		t.Fatal("denied key issuance changed the public key list")
	}
}
