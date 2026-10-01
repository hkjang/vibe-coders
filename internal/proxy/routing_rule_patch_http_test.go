package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// The first body read occurs after the handler's existing lookup. A controlled
// second actor changes the real fixture DB at that boundary, without timing
// sleeps or a mock Store. The resulting write must not reuse the old snapshot.
type routingPatchInterleaveBody struct {
	reader io.Reader
	once   sync.Once
	before func()
}

func (b *routingPatchInterleaveBody) Read(p []byte) (int, error) {
	b.once.Do(b.before)
	return b.reader.Read(p)
}

func (*routingPatchInterleaveBody) Close() error { return nil }

func routingPatchHTTPFixture(t *testing.T) (*store.SQLStore, *Server, store.RoutingRule) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	s, err := NewServer(testConfig("http://unused.invalid", "public-test-key"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rule := store.RoutingRule{ID: "route-patch-public", Enabled: true, Priority: 10,
		MatchPattern: "public-*", MinComplexity: 0, MaxComplexity: 100,
		TargetModel: "public-a", TargetProvider: "public-provider", Note: "public-note",
		CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 123, time.UTC)}
	if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
		t.Fatal(err)
	}
	return db, s, rule
}

func routingPatchHTTP(t *testing.T, s *Server, body string, before func()) (*httptest.ResponseRecorder, store.RoutingRule) {
	t.Helper()
	if before == nil {
		before = func() {}
	}
	r := httptest.NewRequest(http.MethodPatch, "/admin/routing-rules/route-patch-public", nil)
	r.Body = &routingPatchInterleaveBody{reader: strings.NewReader(body), before: before}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	var result struct {
		Rule store.RoutingRule `json:"rule"`
	}
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal("invalid successful rule response")
		}
	}
	return w, result.Rule
}

func TestRoutingPatchHTTPCurrentWriteBoundary(t *testing.T) {
	t.Run("ordinary_partial_edit_preserves_unmentioned_fields", func(t *testing.T) {
		db, s, original := routingPatchHTTPFixture(t)
		w, got := routingPatchHTTP(t, s, `{"target_model":" public-b "}`, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("status=%d", w.Code)
		}
		want := original
		want.TargetModel = "public-b"
		if got != want {
			t.Fatal("partial edit response differs from expected row")
		}
		rows, err := db.ListRoutingRules(t.Context())
		if err != nil || len(rows) != 1 || rows[0] != want {
			t.Fatal("partial edit was not persisted")
		}
	})
	t.Run("delete_after_lookup_is_not_reinserted", func(t *testing.T) {
		db, s, original := routingPatchHTTPFixture(t)
		w, _ := routingPatchHTTP(t, s, `{"note":"new-note"}`, func() {
			if err := db.DeleteRoutingRule(t.Context(), original.ID); err != nil {
				t.Fatal(err)
			}
		})
		if w.Code != http.StatusNotFound {
			t.Errorf("status=%d, want 404 after the controlled delete", w.Code)
		}
		rows, err := db.ListRoutingRules(t.Context())
		if err != nil || len(rows) != 0 {
			t.Error("PATCH reinserted the deleted rule")
		}
	})
	t.Run("omitted_enabled_and_fields_preserve_interleaved_update", func(t *testing.T) {
		db, s, want := routingPatchHTTPFixture(t)
		want.Enabled = false
		want.Priority = 77
		want.TargetProvider = "public-new-provider"
		w, got := routingPatchHTTP(t, s, `{"target_model":"public-b"}`, func() {
			if err := db.UpsertRoutingRule(t.Context(), want); err != nil {
				t.Fatal(err)
			}
		})
		want.TargetModel = "public-b"
		if w.Code != http.StatusOK || got != want {
			t.Errorf("status=%d; ACK must reflect current omitted fields", w.Code)
		}
		rows, err := db.ListRoutingRules(t.Context())
		if err != nil || len(rows) != 1 || rows[0] != want {
			t.Error("PATCH overwrote the second actor's omitted fields")
		}
	})
	t.Run("merged_range_uses_current_database_bound", func(t *testing.T) {
		db, s, want := routingPatchHTTPFixture(t)
		want.MaxComplexity = 30
		w, _ := routingPatchHTTP(t, s, `{"min_complexity":40,"note":"must-not-apply"}`, func() {
			if err := db.UpsertRoutingRule(t.Context(), want); err != nil {
				t.Fatal(err)
			}
		})
		if w.Code != http.StatusBadRequest {
			t.Errorf("status=%d, want 400 for the current merged range", w.Code)
		}
		rows, err := db.ListRoutingRules(t.Context())
		if err != nil || len(rows) != 1 || rows[0] != want {
			t.Error("invalid current-range PATCH changed the row")
		}
	})
	t.Run("range_relaxed_after_lookup_is_not_rejected_by_stale_bound", func(t *testing.T) {
		db, s, original := routingPatchHTTPFixture(t)
		original.MaxComplexity = 30
		if err := db.UpsertRoutingRule(t.Context(), original); err != nil {
			t.Fatal(err)
		}
		w, got := routingPatchHTTP(t, s, `{"min_complexity":40}`, func() {
			original.MaxComplexity = 80
			if err := db.UpsertRoutingRule(t.Context(), original); err != nil {
				t.Fatal(err)
			}
		})
		if w.Code != http.StatusOK || got.MinComplexity != 40 || got.MaxComplexity != 80 {
			t.Fatalf("status=%d; current valid merged range rejected", w.Code)
		}
	})
}

func TestRoutingPatchHTTPValueContract(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		change     func(*store.RoutingRule)
	}{
		{"omitted", `{}`, 200, nil},
		{"whole_null", `null`, 200, nil},
		{"field_nulls", `{"enabled":null,"priority":null,"match_pattern":null,"min_complexity":null,"max_complexity":null,"target_model":null,"target_provider":null,"note":null}`, 200, nil},
		{"false_zero_clear", `{"enabled":false,"min_complexity":0,"max_complexity":0,"match_pattern":"  ","target_provider":" ","note":" "}`, 200, func(r *store.RoutingRule) {
			r.Enabled, r.MaxComplexity, r.MatchPattern, r.TargetProvider, r.Note = false, 0, "*", "", ""
		}},
		{"normalize_and_ignore_identity", `{"id":"different","created_at":"different","target_model":" public-new ","target_provider":" next ","note":" note ","priority":3}`, 200, func(r *store.RoutingRule) {
			r.TargetModel, r.TargetProvider, r.Note, r.Priority = "public-new", "next", "note", 3
		}},
		{"zero_priority", `{"priority":0}`, 400, nil},
		{"blank_model", `{"target_model":" "}`, 400, nil},
		{"negative_min", `{"min_complexity":-1}`, 400, nil},
		{"large_max", `{"max_complexity":101}`, 400, nil},
		{"reversed", `{"min_complexity":10,"max_complexity":5}`, 400, nil},
		{"numeric_string", `{"priority":"3"}`, 400, nil},
		{"fraction", `{"priority":1.5}`, 400, nil},
		{"overflow", `{"priority":999999999999999999999999}`, 400, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, want := routingPatchHTTPFixture(t)
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{want}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			w, got := routingPatchHTTP(t, s, tc.body, nil)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d", w.Code, tc.status)
			}
			if tc.change != nil {
				tc.change(&want)
			}
			rows, err := db.ListRoutingRules(t.Context())
			if err != nil || len(rows) != 1 || rows[0] != want {
				t.Fatal("stored row contract mismatch")
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil {
				t.Fatal(err)
			}
			if tc.status == 200 {
				if got != want || s.routingRules.Load() != nil || len(audits) != 1 || audits[0].Action != "routing_rule.update" {
					t.Fatal("successful ACK/cache/audit contract mismatch")
				}
				var payload map[string]json.RawMessage
				var out map[string]json.RawMessage
				if json.Unmarshal(w.Body.Bytes(), &out) != nil || json.Unmarshal(out["rule"], &payload) != nil || len(payload) != 10 {
					t.Fatal("ACK must contain all ten actual row fields")
				}
			} else if s.routingRules.Load() != cached || len(audits) != 0 {
				t.Fatal("rejected PATCH changed cache/audit")
			}
		})
	}
}

func TestRoutingPatchHTTPPermissionContract(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		scopes     []string
		get, patch int
	}{
		{"jwt_read", "jwt", []string{"routing:read"}, 200, 401},
		{"jwt_write", "jwt", []string{"routing:write"}, 401, 200},
		{"jwt_both", "jwt", []string{"routing:read", "routing:write"}, 200, 200},
		{"jwt_neither", "jwt", nil, 401, 401},
		{"legacy_read", "legacy_read", nil, 200, 401},
		{"legacy_write", "legacy_write", nil, 200, 200},
		{"auth_disabled", "off", nil, 200, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, original := routingPatchHTTPFixture(t)
			token := ""
			switch tc.mode {
			case "jwt":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-routing-patch-jwt-key"
				token = issueLLMScopedTestToken(t, db, s, tc.name, "contract_operator", "", tc.scopes, time.Now().UTC())
			case "legacy_read":
				s.cfg.Auth.AdminReadonlyToken = "public-routing-read"
				token = s.cfg.Auth.AdminReadonlyToken
			case "legacy_write":
				s.cfg.Auth.AdminToken = "public-routing-write"
				token = s.cfg.Auth.AdminToken
			}
			for _, method := range []string{http.MethodGet, http.MethodPatch} {
				path, status := "/admin/routing-rules", tc.get
				if method == http.MethodPatch {
					path, status = path+"/"+original.ID, tc.patch
				}
				r := httptest.NewRequest(method, path, strings.NewReader(`{"note":"permitted"}`))
				if token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				s.Routes().ServeHTTP(w, r)
				if w.Code != status {
					t.Fatalf("%s status=%d want=%d", method, w.Code, status)
				}
			}
			rows, err := db.ListRoutingRules(t.Context())
			if tc.patch == 200 {
				original.Note = "permitted"
			}
			if err != nil || len(rows) != 1 || rows[0] != original {
				t.Fatal("authorization storage contract mismatch")
			}
		})
	}
}
