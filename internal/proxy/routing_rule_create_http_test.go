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

// Actual Routes and SQLStore; all values and upstreams are synthetic. These
// tests document the existing create behavior, not a new parser or transaction.
func routingCreateFixture(t *testing.T) (*store.SQLStore, *Server, store.RoutingRule) {
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
	s, err := NewServer(testConfig(upstream.URL, "public-create-upstream"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	other := store.RoutingRule{ID: "create-other", Enabled: false, Priority: 11,
		MatchPattern: "public-other-*", MinComplexity: 10, MaxComplexity: 90,
		TargetModel: "public-other-model", TargetProvider: "public-other-provider", Note: "public-other-note",
		CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 123, time.UTC)}
	if err := db.UpsertRoutingRule(t.Context(), other); err != nil {
		t.Fatal(err)
	}
	return db, s, other
}

func routingCreateRequest(t *testing.T, s *Server, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}

func routingCreateACK(t *testing.T, w *httptest.ResponseRecorder) store.RoutingRule {
	t.Helper()
	var envelope map[string]json.RawMessage
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || len(envelope) != 1 {
		t.Fatalf("create acknowledgment mismatch, status=%d", w.Code)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(envelope["rule"], &fields) != nil || len(fields) != 10 {
		t.Fatal("create acknowledgment must contain all ten rule fields")
	}
	for _, key := range []string{"id", "enabled", "priority", "match_pattern", "min_complexity", "max_complexity", "target_model", "target_provider", "note", "created_at"} {
		if raw, ok := fields[key]; !ok || string(raw) == "null" {
			t.Fatalf("create acknowledgment missing non-null field %s", key)
		}
	}
	var rule store.RoutingRule
	if json.Unmarshal(envelope["rule"], &rule) != nil || strings.TrimSpace(rule.ID) == "" || !rule.CreatedAt.IsZero() {
		t.Fatal("create acknowledgment identity or existing zero timestamp changed")
	}
	return rule
}

func assertRoutingCreateUntouched(t *testing.T, db *store.SQLStore, s *Server, other store.RoutingRule, cached *routingRulesSnapshot) {
	t.Helper()
	rows, err := db.ListRoutingRules(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || len(rows) != 1 || rows[0] != other || len(audits) != 0 || s.routingRules.Load() != cached {
		t.Fatal("rejected create changed rules, local cache or admin mutation audit; auth events are separate")
	}
}

func TestRoutingCreateHTTPNormalization(t *testing.T) {
	defaults := store.RoutingRule{Enabled: true, Priority: 100, MatchPattern: "*", TargetModel: "public-model"}
	for _, tc := range []struct {
		name, body string
		want       store.RoutingRule
	}{
		{"minimal_defaults", `{"target_model":"public-model"}`, defaults},
		{"nullable_defaults", `{"target_model":"public-model","enabled":null,"priority":null,"match_pattern":null,"min_complexity":null,"max_complexity":null,"target_provider":null,"note":null}`, defaults},
		{"false_and_zero", `{"target_model":"public-model","enabled":false,"priority":0,"min_complexity":0,"max_complexity":0}`, store.RoutingRule{Priority: 100, MatchPattern: "*", TargetModel: "public-model"}},
		{"negative_priority", `{"target_model":"public-model","priority":-5}`, defaults},
		{"explicit_values", `{"match_pattern":" public-* ","min_complexity":12,"max_complexity":89,"target_model":" public-model ","target_provider":" public-provider ","priority":7,"enabled":true,"note":" 공개 메모 "}`, store.RoutingRule{Enabled: true, Priority: 7, MatchPattern: "public-*", MinComplexity: 12, MaxComplexity: 89, TargetModel: "public-model", TargetProvider: "public-provider", Note: "공개 메모"}},
		{"go_unicode_space", `{"target_model":"\u0085public-model\u0085","match_pattern":"\u0085","note":"\u0085"}`, defaults},
		{"case_aliases", `{"TARGET_MODEL":"public-model","PRIORITY":null}`, defaults},
		{"duplicate_then_null", `{"target_model":"old","target_model":"public-model","target_model":null,"enabled":false,"enabled":null}`, defaults},
		{"unknown_and_trailing", `{"target_model":"public-model","id":"create-other","created_at":"2020-01-01T00:00:00Z","unknown":{"nested":true}} {"target_model":"not-decoded"}`, defaults},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			s.routingRules.Store(&routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()})
			ack := routingCreateACK(t, routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", tc.body, ""))
			want := tc.want
			want.ID = ack.ID
			if ack != want || ack.ID == other.ID || s.routingRules.Load() != nil {
				t.Fatal("normalized create acknowledgment or local cache invalidation mismatch")
			}
			rows, err := db.ListRoutingRules(t.Context())
			if err != nil || len(rows) != 2 {
				t.Fatal("create must add one fixture row")
			}
			found := false
			for _, row := range rows {
				if row.ID == other.ID {
					if row != other {
						t.Fatal("create changed an unrelated row")
					}
					continue
				}
				if row.ID != ack.ID || row.CreatedAt.IsZero() {
					t.Fatal("stored create identity/time mismatch")
				}
				row.CreatedAt = time.Time{}
				if row != ack {
					t.Fatal("stored configuration differs from normalized acknowledgment")
				}
				found = true
			}
			if !found {
				t.Fatal("created row not found")
			}
			get := routingCreateRequest(t, s, http.MethodGet, "/admin/routing-rules", "", "")
			var listed struct {
				Rules []store.RoutingRule `json:"rules"`
			}
			if get.Code != 200 || json.Unmarshal(get.Body.Bytes(), &listed) != nil || len(listed.Rules) != 2 {
				t.Fatal("actual GET failed to expose the persisted collection")
			}
			for i, row := range listed.Rules {
				if row != rows[i] {
					t.Fatal("GET must reflect stored creation time, not the POST zero-time copy")
				}
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			var audited store.RoutingRule
			if err != nil || len(audits) != 1 || audits[0].Action != "routing_rule.create" || audits[0].BeforeValue != "" ||
				json.Unmarshal([]byte(audits[0].AfterValue), &audited) != nil || audited != ack {
				t.Fatal("create audit must retain the normalized handler copy, including its zero time")
			}
		})
	}
}

func TestRoutingCreateHTTPInvalidInput(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"empty", ``, "invalid_body"},
		{"malformed", `{`, "invalid_body"},
		{"empty_object", `{}`, "missing_target_model"},
		{"top_null", `null`, "missing_target_model"},
		{"target_null", `{"target_model":null}`, "missing_target_model"},
		{"blank_target", `{"target_model":" \n\t "}`, "missing_target_model"},
		{"negative_min", `{"target_model":"public-model","min_complexity":-1}`, "invalid_range"},
		{"max_over_100", `{"target_model":"public-model","max_complexity":101}`, "invalid_range"},
		{"reversed_bounds", `{"target_model":"public-model","min_complexity":51,"max_complexity":50}`, "invalid_range"},
		{"negative_max", `{"target_model":"public-model","max_complexity":-1}`, "invalid_range"},
		{"fractional_integer", `{"target_model":"public-model","priority":1.5}`, "invalid_body"},
		{"exponent_integer", `{"target_model":"public-model","priority":1e2}`, "invalid_body"},
		{"string_integer", `{"target_model":"public-model","priority":"2"}`, "invalid_body"},
		{"integer_overflow", `{"target_model":"public-model","priority":9223372036854775808}`, "invalid_body"},
		{"string_boolean", `{"target_model":"public-model","enabled":"true"}`, "invalid_body"},
		{"number_target", `{"target_model":5}`, "invalid_body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			w := routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", tc.body, "")
			var body struct {
				Error struct{ Code string } `json:"error"`
			}
			if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != tc.code {
				t.Fatalf("invalid input classification mismatch, status=%d", w.Code)
			}
			assertRoutingCreateUntouched(t, db, s, other, cached)
		})
	}
}

func TestRoutingCreateHTTPRepeatedNormalRequests(t *testing.T) {
	db, s, other := routingCreateFixture(t)
	seen := map[string]bool{other.ID: true}
	// The normal random-ID path creates different rows; this is not an
	// idempotency or mathematical collision/fallback guarantee for newID.
	for attempt := 0; attempt < 3; attempt++ {
		ack := routingCreateACK(t, routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", `{"target_model":"public-model"}`, ""))
		if seen[ack.ID] {
			t.Fatal("normal repeated fixture request reused an identity")
		}
		seen[ack.ID] = true
	}
	rows, err := db.ListRoutingRules(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || len(rows) != 4 || len(audits) != 3 {
		t.Fatal("normal repeated POSTs must not be treated as one idempotent operation")
	}
	for _, row := range rows {
		if !seen[row.ID] || (row.ID == other.ID && row != other) {
			t.Fatal("repeated create changed unrelated identity/data")
		}
	}
}

func TestRoutingCreateHTTPPermissionContract(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role string
		scopes           []string
		read, create     int
	}{
		{"routing_read", "jwt", "operator", []string{"routing:read"}, 200, 401},
		{"routing_write", "jwt", "operator", []string{"routing:write"}, 401, 201},
		{"routing_both", "jwt", "operator", []string{"routing:read", "routing:write"}, 200, 201},
		{"admin_read", "jwt", "operator", []string{"admin:read"}, 401, 401},
		{"admin_write", "jwt", "operator", []string{"admin:write"}, 401, 401},
		{"role_without_scope", "jwt", "super_admin", nil, 401, 401},
		{"team_read", "jwt", "team_admin", []string{"routing:read"}, 200, 401},
		{"missing_jwt", "missing", "", nil, 401, 401},
		{"invalid_jwt", "invalid", "", nil, 401, 401},
		{"legacy_readonly", "readonly", "", nil, 200, 401},
		{"legacy_full", "legacy", "", nil, 200, 201},
		{"open", "open", "", nil, 200, 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			token := ""
			switch tc.mode {
			case "jwt", "missing", "invalid":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-create-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, tc.role, "", tc.scopes, time.Now().UTC())
				} else if tc.mode == "invalid" {
					token = "public-invalid-jwt"
				}
			case "readonly", "legacy":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "public-create-full", "public-create-read"
				token = s.cfg.Auth.AdminReadonlyToken
				if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			read := routingCreateRequest(t, s, http.MethodGet, "/admin/routing-rules", "", token)
			if read.Code != tc.read {
				t.Fatalf("GET status=%d want=%d", read.Code, tc.read)
			}
			create := routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", `{"target_model":"public-model"}`, token)
			if create.Code != tc.create {
				t.Fatalf("POST status=%d want=%d", create.Code, tc.create)
			}
			if tc.create != 201 {
				assertRoutingCreateUntouched(t, db, s, other, cached)
				return
			}
			ack := routingCreateACK(t, create)
			rows, err := db.ListRoutingRules(t.Context())
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil || len(rows) != 2 || len(audits) != 1 || s.routingRules.Load() != nil {
				t.Fatal("authorized POST persistence/cache/audit mismatch")
			}
			for _, row := range rows {
				if row.ID == other.ID {
					if row != other {
						t.Fatal("authorized POST changed unrelated row")
					}
				} else if row.ID != ack.ID || row.CreatedAt.IsZero() {
					t.Fatal("authorized POST persisted unexpected row")
				}
			}
		})
	}
}

func TestRoutingCreateHTTPPathAndMethods(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		status             int
	}{
		{"trailing_slash", http.MethodPost, "/admin/routing-rules/", 400},
		{"post_by_id", http.MethodPost, "/admin/routing-rules/create-other", 405},
		{"collection_put", http.MethodPut, "/admin/routing-rules", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			w := routingCreateRequest(t, s, tc.method, tc.path, `{"target_model":"public-model"}`, "")
			if w.Code != tc.status {
				t.Fatalf("route/method status=%d want=%d", w.Code, tc.status)
			}
			assertRoutingCreateUntouched(t, db, s, other, cached)
		})
	}
}

func TestRoutingCreateHTTPDatabaseFailure(t *testing.T) {
	db, s, other := routingCreateFixture(t)
	cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
	s.routingRules.Store(cached)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	w := routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", `{"target_model":"public-model"}`, "")
	var body struct {
		Error struct{ Code string } `json:"error"`
	}
	if w.Code != 500 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != "routing_rule_save_failed" || s.routingRules.Load() != cached {
		t.Fatal("store failure must retain cache and return an error, not a create acknowledgment")
	}
}

func TestRoutingCreateHTTPConfiguredPostChange(t *testing.T) {
	db, s, _ := routingCreateFixture(t)
	s.cfg.RedTeam.PostChangeEnabled = true
	s.cfg.RedTeam.PostChangeMaxTargets = 1
	ack := routingCreateACK(t, routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", `{"target_model":"public-model"}`, ""))
	campaigns, err := db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatal("successful POST lost its configured post-change campaign")
	}
	c := campaigns[0]
	if c.TriggerAction != "routing_rule.create" || c.TriggerSource != "post-change" || c.TriggerRef != ack.ID || c.ExecutionMode != "dry-run" || c.ExternalProviderAllowed {
		t.Fatal("create post-change campaign safety/target contract mismatch")
	}
}
