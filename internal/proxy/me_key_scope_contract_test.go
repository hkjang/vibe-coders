package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Personal key editing intentionally differs from admin PATCH: omitted/null
// scopes also clear grants. Neither endpoint's edit inherits role defaults.
func TestMeKeyScopeContractEmptyPatchClearsOnlyGrants(t *testing.T) {
	for _, body := range []string{`{"scopes":[]}`, `{}`, `{"scopes":null}`} {
		t.Run(body, func(t *testing.T) {
			f := newMeKeyScopeContractFixture(t, true, []string{"chat:completion", "models:read"})
			id, secret := f.seed(t, "me-scope-own", "me-scope-user")
			f.assertChat(t, secret, http.StatusOK)
			before := f.key(t, id)
			data := f.request(t, http.MethodPatch, "/me/keys/"+id, f.callerToken, body, http.StatusOK)
			var response struct {
				ID     string   `json:"id"`
				Scopes []string `json:"scopes"`
			}
			if json.Unmarshal(data, &response) != nil || response.ID != id || response.Scopes == nil || len(response.Scopes) != 0 {
				t.Fatal("personal PATCH must return an explicit empty grant list")
			}
			after := f.key(t, id)
			if len(after.Scopes) != 0 {
				t.Fatal("personal PATCH must persist no grants, not role defaults")
			}
			after.Scopes = before.Scopes
			if !reflect.DeepEqual(before, after) {
				t.Fatal("scope editing changed an unrelated key field")
			}
			events, err := f.db.ListAuditEvents(t.Context(), 20)
			if err != nil || !slices.ContainsFunc(events, func(event store.AuthEvent) bool {
				return event.EventType == "api_key_scopes_updated" && event.APIKeyID == id &&
					event.ActorUserID == "me-scope-user" && event.TeamID == "me-scope-team"
			}) {
				t.Fatal("personal scope changes must retain the authenticated actor audit event")
			}
			f.assertChat(t, secret, http.StatusUnauthorized)
			f.request(t, http.MethodPatch, "/me/keys/"+id, f.callerToken,
				`{"scopes":[" chat:completion ","chat:completion"," "]}`, http.StatusOK)
			if !slices.Equal(f.key(t, id).Scopes, []string{"chat:completion"}) {
				t.Fatal("personal PATCH must normalize only the explicitly supplied grants")
			}
			f.assertChat(t, secret, http.StatusOK)
		})
	}
}

func TestMeKeyScopeContractIssuanceUsesCurrentCallerGrants(t *testing.T) {
	for _, body := range []string{
		`{"name":"synthetic personal key"}`,
		`{"name":"synthetic personal key","scopes":[]}`,
		`{"name":"synthetic personal key","scopes":null}`,
	} {
		t.Run(body, func(t *testing.T) {
			// A developer role does not expand this narrower caller to all of the
			// developer defaults. Creation captures the caller's current grants.
			f := newMeKeyScopeContractFixture(t, true, []string{"models:read"})
			var response struct {
				APIKey struct {
					ID     string   `json:"id"`
					Scopes []string `json:"scopes"`
				} `json:"api_key"`
				Secret string `json:"secret"`
			}
			data := f.request(t, http.MethodPost, "/me/keys", f.callerToken, body, http.StatusCreated)
			if json.Unmarshal(data, &response) != nil || response.APIKey.ID == "" || response.Secret == "" ||
				!slices.Equal(response.APIKey.Scopes, []string{"models:read"}) {
				t.Fatal("personal issuance must use current caller grants when none are requested")
			}
			stored := f.key(t, response.APIKey.ID)
			if stored.UserID != "me-scope-user" || stored.Role != "developer" || stored.KeyHash != hashProxyKey(response.Secret) ||
				!slices.Equal(stored.Scopes, []string{"models:read"}) {
				t.Fatal("personal issuance did not preserve ownership, hashed secret and caller grants")
			}
			f.assertChat(t, response.Secret, http.StatusUnauthorized)
		})
	}
}

func TestMeKeyScopeContractDenialsLeaveStoredKeyUnchanged(t *testing.T) {
	for _, tc := range []struct {
		name, body, owner, token, code string
		enabled                        bool
		status                         int
	}{
		{"unsupported scope", `{"scopes":["fixture:unsupported"]}`, "me-scope-user", "caller", "invalid_scope", true, http.StatusBadRequest},
		{"scope beyond caller", `{"scopes":["admin:write"]}`, "me-scope-user", "caller", "scope_denied", true, http.StatusForbidden},
		{"other user's key", `{"scopes":[]}`, "me-scope-other", "caller", "api_key_not_found", true, http.StatusNotFound},
		{"unknown key", `{"scopes":[]}`, "me-scope-user", "missing", "api_key_not_found", true, http.StatusNotFound},
		{"unauthenticated", `{"scopes":[]}`, "me-scope-user", "", "invalid_api_key", true, http.StatusUnauthorized},
		{"self service disabled", `{"scopes":[]}`, "me-scope-user", "caller", "not_found", false, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMeKeyScopeContractFixture(t, tc.enabled, []string{"chat:completion", "models:read"})
			id, _ := f.seed(t, "me-scope-denied", tc.owner)
			before := f.key(t, id)
			target, token := id, f.callerToken
			if tc.token == "" {
				token = ""
			} else if tc.token == "missing" {
				target = "me-scope-absent"
			}
			data := f.request(t, http.MethodPatch, "/me/keys/"+target, token, tc.body, tc.status)
			var response struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(data, &response) != nil || response.Error.Code != tc.code || !reflect.DeepEqual(before, f.key(t, id)) {
				t.Fatal("personal key rejection must retain the complete record and stable error contract")
			}
		})
	}
}

func TestMeKeyScopeContractConfirmedEmptyGrantableAllowsClearing(t *testing.T) {
	f := newMeKeyScopeContractFixture(t, true, []string{})
	id, _ := f.seed(t, "me-scope-empty-caller", "me-scope-user")
	var response struct {
		Grantable *[]string `json:"grantable_scopes"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, "/me/keys", f.callerToken, "", http.StatusOK), &response) != nil ||
		response.Grantable == nil || len(*response.Grantable) != 0 {
		t.Fatal("a confirmed empty personal grant catalog must be present, not missing or null")
	}
	f.request(t, http.MethodPatch, "/me/keys/"+id, f.callerToken, `{"scopes":[]}`, http.StatusOK)
	if len(f.key(t, id).Scopes) != 0 {
		t.Fatal("an identified caller with no grants must still be able to clear their own key")
	}
}

type meKeyScopeContractFixture struct {
	*apiKeyScopeContractFixture
	callerToken string
}

func newMeKeyScopeContractFixture(t *testing.T, enabled bool, grants []string) *meKeyScopeContractFixture {
	t.Helper()
	f := &meKeyScopeContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f.upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"synthetic response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	t.Cleanup(upstream.Close)
	f.db = openTestStore(t)
	logger := store.NewAsyncLogger(f.db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstream.URL, "synthetic-me-key-upstream")
	cfg.Auth.Enabled, cfg.Auth.SelfServiceKeys = true, enabled
	cfg.Auth.JWTSecret = "synthetic-me-key-scope-contract"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, f.db, logger, nil)
	if err != nil {
		t.Fatal("personal key contract gateway initialization failed")
	}
	f.gateway = httptest.NewServer(server.Routes())
	t.Cleanup(f.gateway.Close)
	f.callerToken = issueLLMScopedTestToken(t, f.db, server, "me-scope-user", "developer", "me-scope-team", grants, time.Now().UTC())
	return f
}

func (f *meKeyScopeContractFixture) seed(t *testing.T, id, owner string) (string, string) {
	t.Helper()
	secret := "vc_sk_synthetic_" + id
	if f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: id, Name: "personal scope contract", KeyHash: hashProxyKey(secret),
		Owner: "synthetic owner", UserID: owner, Team: "me-scope-team", Role: "developer",
		Status: "active", Scopes: []string{"chat:completion"},
		AllowedModels: []string{"test-model"}, BudgetLimitKRW: 1234,
		ExpiresAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second),
	}) != nil {
		t.Fatal("personal key contract seed failed")
	}
	return id, secret
}
