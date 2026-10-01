package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These fixtures exercise the actual Routes, SQLStore and audit/cache behavior.
// All upstreams are synthetic loopback sentinels; none may receive a request.
func routingDeleteFixture(t *testing.T) (*store.SQLStore, *Server, store.RoutingRule, store.RoutingRule) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if calls.Load() != 0 {
			t.Errorf("unexpected synthetic upstream calls: %d", calls.Load())
		}
	})
	s, err := NewServer(testConfig(upstream.URL, "public-delete-upstream"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	target := store.RoutingRule{ID: "delete-target", Enabled: true, Priority: 10,
		MatchPattern: "public-*", MinComplexity: 0, MaxComplexity: 100,
		TargetModel: "public-a", TargetProvider: "public-provider", Note: "public-note",
		CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 123, time.UTC)}
	other := target
	other.ID, other.Priority = "delete-other", 20
	for _, rule := range []store.RoutingRule{target, other} {
		if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
			t.Fatal(err)
		}
	}
	return db, s, target, other
}

func routingDeleteRequest(t *testing.T, s *Server, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	// A deliberately malformed body confirms DELETE does not introduce JSON
	// input semantics. Routes are real; no authorization or store is mocked.
	r := httptest.NewRequest(method, path, strings.NewReader("not-json"))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}

func assertRoutingDeleteACK(t *testing.T, w *httptest.ResponseRecorder, id string) {
	t.Helper()
	var ack map[string]string
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &ack) != nil ||
		len(ack) != 2 || ack["id"] != id || ack["status"] != "deleted" {
		t.Fatalf("DELETE acknowledgment mismatch, status=%d", w.Code)
	}
}

func TestRoutingDeleteHTTPIdempotentPersistence(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		name := "enabled"
		if !enabled {
			name = "disabled"
		}
		t.Run(name, func(t *testing.T) {
			db, s, target, other := routingDeleteFixture(t)
			target.Enabled = enabled
			if err := db.UpsertRoutingRule(t.Context(), target); err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for attempt, id := range []string{target.ID, target.ID, "never-existed"} {
				s.routingRules.Store(&routingRulesSnapshot{rules: []store.RoutingRule{target, other}, fetchedAt: time.Now()})
				w := routingDeleteRequest(t, s, http.MethodDelete, "/admin/routing-rules/"+id+"?ignored=1", "")
				assertRoutingDeleteACK(t, w, id)
				rows, err := db.ListRoutingRules(t.Context())
				if err != nil || len(rows) != 1 || rows[0] != other || s.routingRules.Load() != nil {
					t.Fatal("DELETE must preserve the unrelated row and invalidate this server's cache")
				}
				audits, err := db.ListAdminAudit(t.Context(), 10)
				if err != nil || len(audits) != attempt+1 {
					t.Fatal("even repeated/missing DELETE retains the existing per-request audit")
				}
				var added []store.AdminAuditPublic
				for _, audit := range audits {
					if !seen[audit.ID] {
						added = append(added, audit)
					}
				}
				if len(added) != 1 {
					t.Fatal("audit identity difference must contain exactly one new record")
				}
				audit := added[0]
				var before map[string]string
				if audit.Action != "routing_rule.delete" || audit.AfterValue != "" ||
					json.Unmarshal([]byte(audit.BeforeValue), &before) != nil || len(before) != 1 || before["id"] != id {
					t.Fatal("DELETE audit must contain requested ID, not a claimed deleted-row snapshot")
				}
				seen[audit.ID] = true
			}
		})
	}
}

func TestRoutingDeleteHTTPPermissionContract(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role string
		scopes           []string
		read, remove     int
	}{
		{"routing_read", "jwt", "operator", []string{"routing:read"}, 200, 401},
		{"routing_write", "jwt", "operator", []string{"routing:write"}, 401, 200},
		{"routing_both", "jwt", "operator", []string{"routing:read", "routing:write"}, 200, 200},
		{"admin_read", "jwt", "operator", []string{"admin:read"}, 401, 401},
		{"admin_write", "jwt", "operator", []string{"admin:write"}, 401, 401},
		{"role_without_scope", "jwt", "super_admin", nil, 401, 401},
		{"team_read", "jwt", "team_admin", []string{"routing:read"}, 200, 401},
		{"missing_jwt", "missing", "", nil, 401, 401},
		{"invalid_jwt", "invalid", "", nil, 401, 401},
		{"legacy_readonly", "readonly", "", nil, 200, 401},
		{"legacy_full", "legacy", "", nil, 200, 200},
		{"open", "open", "", nil, 200, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, target, other := routingDeleteFixture(t)
			token := ""
			switch tc.mode {
			case "jwt", "missing", "invalid":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-delete-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, tc.role, "", tc.scopes, time.Now().UTC())
				} else if tc.mode == "invalid" {
					token = "public-invalid-jwt"
				}
			case "readonly", "legacy":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "public-delete-full", "public-delete-read"
				token = s.cfg.Auth.AdminReadonlyToken
				if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{target, other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			read := routingDeleteRequest(t, s, http.MethodGet, "/admin/routing-rules", token)
			if read.Code != tc.read {
				t.Fatalf("GET status=%d want=%d", read.Code, tc.read)
			}
			remove := routingDeleteRequest(t, s, http.MethodDelete, "/admin/routing-rules/"+target.ID, token)
			if remove.Code != tc.remove {
				t.Fatalf("DELETE status=%d want=%d", remove.Code, tc.remove)
			}
			rows, err := db.ListRoutingRules(t.Context())
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil {
				t.Fatal("cannot inspect fixture persistence")
			}
			if tc.remove == 200 {
				assertRoutingDeleteACK(t, remove, target.ID)
				if len(rows) != 1 || rows[0] != other || len(audits) != 1 || s.routingRules.Load() != nil {
					t.Fatal("authorized DELETE persistence/cache/audit mismatch")
				}
			} else if len(rows) != 2 || rows[0] != target || rows[1] != other || len(audits) != 0 || s.routingRules.Load() != cached {
				t.Fatal("denied DELETE changed rules, local cache or admin mutation audit; auth events are separate")
			}
		})
	}
}

func TestRoutingDeleteHTTPPathAndMethods(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		status             int
	}{
		{"missing_id", http.MethodDelete, "/admin/routing-rules/", 400},
		{"nested_id", http.MethodDelete, "/admin/routing-rules/delete-target/extra", 400},
		{"encoded_slash", http.MethodDelete, "/admin/routing-rules/delete-target%2Fextra", 400},
		{"collection_not_delete", http.MethodDelete, "/admin/routing-rules", 405},
		{"single_get_not_supported", http.MethodGet, "/admin/routing-rules/delete-target", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, target, other := routingDeleteFixture(t)
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{target, other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			w := routingDeleteRequest(t, s, tc.method, tc.path, "")
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d", w.Code, tc.status)
			}
			rows, err := db.ListRoutingRules(t.Context())
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil || len(rows) != 2 || rows[0] != target || rows[1] != other || len(audits) != 0 || s.routingRules.Load() != cached {
				t.Fatal("invalid route/method changed fixture data, audit or cache")
			}
		})
	}
}

func TestRoutingDeleteHTTPDatabaseFailure(t *testing.T) {
	db, s, target, _ := routingDeleteFixture(t)
	cached := &routingRulesSnapshot{rules: []store.RoutingRule{target}, fetchedAt: time.Now()}
	s.routingRules.Store(cached)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	w := routingDeleteRequest(t, s, http.MethodDelete, "/admin/routing-rules/"+target.ID, "")
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if w.Code != 500 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != "routing_rule_delete_failed" || s.routingRules.Load() != cached {
		t.Fatal("store failure must retain cache and return the existing error, not a delete ACK")
	}
}

func TestRoutingDeleteHTTPConfiguredPostChange(t *testing.T) {
	db, s, target, other := routingDeleteFixture(t)
	s.cfg.RedTeam.PostChangeEnabled = true
	s.cfg.RedTeam.PostChangeMaxTargets = 1
	w := routingDeleteRequest(t, s, http.MethodDelete, "/admin/routing-rules/"+target.ID, "")
	assertRoutingDeleteACK(t, w, target.ID)
	rows, err := db.ListRoutingRules(t.Context())
	if err != nil || len(rows) != 1 || rows[0] != other {
		t.Fatal("configured follow-up changed deletion semantics")
	}
	campaigns, err := db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatal("successful DELETE lost its configured post-change campaign")
	}
	c := campaigns[0]
	if c.TriggerAction != "routing_rule.delete" || c.TriggerSource != "post-change" || c.TriggerRef != target.ID || c.ExecutionMode != "dry-run" || c.ExternalProviderAllowed {
		t.Fatal("DELETE post-change campaign safety/target contract mismatch")
	}
}
