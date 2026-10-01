package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestPolicyImportAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role string
		scopes           []string
		export, write    int
	}{
		{"jwt_security_read", "jwt", "contract_operator", []string{"security:read"}, 200, 401},
		{"jwt_admin_write", "jwt", "contract_operator", []string{"admin:write"}, 401, 200},
		{"jwt_admin_read", "jwt", "contract_operator", []string{"admin:read"}, 401, 401},
		{"role_without_scope", "jwt", "super_admin", nil, 401, 401},
		{"team_role_no_write", "jwt", "team_admin", []string{"security:read"}, 200, 401},
		{"proxy_key_not_jwt", "api_key", "super_admin", []string{"security:read", "admin:write"}, 401, 401},
		{"missing_jwt", "missing", "", nil, 401, 401},
		{"legacy_readonly", "readonly", "", nil, 200, 401},
		{"legacy_full", "legacy", "", nil, 200, 200},
		{"open_mode", "open", "", nil, 200, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, server := newPolicyImportAuthFixture(t, tc.mode, false)
			token := ""
			switch tc.mode {
			case "jwt":
				token = issueLLMScopedTestToken(t, f.db, server, "import-auth-caller", tc.role, "", tc.scopes, time.Now().UTC())
			case "api_key":
				token = "vc_sk_public_import_contract"
				if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "import-key", Name: "public key", KeyHash: hashProxyKey(token), Role: tc.role, Scopes: tc.scopes, Status: "active"}); err != nil {
					t.Fatal(err)
				}
			case "readonly":
				token = "public-import-readonly"
			case "legacy":
				token = "public-import-full"
			}
			before := f.snapshot(t)
			requestPolicyImportAuth(t, f, http.MethodGet, "/admin/policies/export", token, "", tc.export)
			const body = `{"policies":[{"id":"auth-import","name":"public auth policy","enabled":false,"rules":[]}]}`
			requestPolicyImportAuth(t, f, http.MethodPost, "/admin/policies/import?dry_run=1", token, body, tc.write)
			if f.snapshot(t) != before {
				t.Fatal("export or dry-run changed policy/import audit; authentication audits are separate")
			}
			requestPolicyImportAuth(t, f, http.MethodPost, "/admin/policies/import", token, body, tc.write)
			if tc.write == 200 {
				if f.policy(t, "auth-import").Enabled {
					t.Fatal("actual disabled import control became enabled")
				}
				f.assertAuditCounts(t, 1, 1, 0)
			} else if f.snapshot(t) != before {
				t.Fatal("denied import changed policy/import audit")
			}
		})
	}
}

func TestPolicyImportPostChangeHook(t *testing.T) {
	f, _ := newPolicyImportAuthFixture(t, "legacy", true)
	const body = `{"policies":[{"id":"hook-import","name":"public hook policy","enabled":false,"rules":[]}]}`
	requestPolicyImportAuth(t, f, http.MethodPost, "/admin/policies/import?dry_run=1", "public-import-full", body, 200)
	if campaigns, err := f.db.ListRedTeamCampaigns(t.Context(), 20); err != nil || len(campaigns) != 0 {
		t.Fatal("dry-run must not invoke post-change hook")
	}
	requestPolicyImportAuth(t, f, http.MethodPost, "/admin/policies/import", "public-import-full", body, 200)
	f.assertAuditCounts(t, 1, 1, 0)
	campaigns, err := f.db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatal("successful import must retain configured post-change campaign")
	}
	c := campaigns[0]
	if c.TriggerAction != "governance.policy.import" || c.TriggerSource != "post-change" || c.ExecutionMode != "dry-run" || c.ExternalProviderAllowed {
		t.Fatal("post-change import must retain the existing dry-run contract")
	}
	seed, found, err := f.db.GetAdminSetting(t.Context(), "redteam.seed_version")
	if err != nil || !found || seed.ValueJSON != "2" || f.policy(t, "hook-import").Enabled {
		t.Fatal("configured follow-up seed record or disabled import contract changed")
	}
}

func newPolicyImportAuthFixture(t *testing.T, mode string, postChange bool) (*policyImportContractFixture, *Server) {
	t.Helper()
	f := &policyImportContractFixture{db: openTestStore(t)}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if calls.Load() != 0 {
			t.Errorf("unexpected local upstream calls: %d", calls.Load())
		}
	})
	logger := store.NewAsyncLogger(f.db, 32, filepath.Join(t.TempDir(), "import-auth-fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstream.URL, "public-import-upstream")
	cfg.RedTeam.PostChangeEnabled = postChange
	if mode == "jwt" || mode == "api_key" || mode == "missing" {
		cfg.Auth.Enabled, cfg.Auth.JWTSecret = true, "public-import-contract-jwt"
		cfg.Auth.AccessTokenTTL = time.Hour
	} else if mode != "open" {
		cfg.Auth.AdminToken, cfg.Auth.AdminReadonlyToken = "public-import-full", "public-import-readonly"
	}
	server, err := NewServer(cfg, f.db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.gateway = httptest.NewServer(server.Routes())
	t.Cleanup(f.gateway.Close)
	// 빈 캐시의 []/nil 표현 차이 대신 기존 활성 행까지 그대로인지 비교한다.
	seed := policyImportContractPolicy("auth-existing", "auth-existing-rule")
	if err := f.db.UpsertPolicyWithRules(t.Context(), seed, seed.Rules); err != nil {
		t.Fatal(err)
	}
	return f, server
}

func requestPolicyImportAuth(t *testing.T, f *policyImportContractFixture, method, path, token, body string, expected int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+path, bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || response.StatusCode != expected {
		t.Fatalf("response status=%d, want %d; read error=%v", response.StatusCode, expected, err)
	}
	if expected == http.StatusUnauthorized {
		var failure struct{ Error struct{ Code string } }
		if json.Unmarshal(data, &failure) != nil || failure.Error.Code != "invalid_api_key" {
			t.Fatal("existing authorization failure contract changed")
		}
	}
	return data
}
