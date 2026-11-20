package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestRoutingRuleDetailHTTPExactIdentityAndInvalidQuery(t *testing.T) {
	db, s, other := routingCreateFixture(t)
	rule := other
	rule.ID = "분기/정산?%#"
	if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
		t.Fatal(err)
	}
	cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
	s.routingRules.Store(cached)
	for _, id := range []string{rule.ID, other.ID, "missing", strings.ToUpper(other.ID), "create-oth", "' OR 1=1 --"} {
		w := routingCreateRequest(t, s, "GET", "/admin/routing-rules?"+url.Values{"id": {id}}.Encode(), "", "")
		var response struct {
			Rules []store.RoutingRule `json:"rules"`
		}
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(w.Body.Bytes(), &response) != nil {
			t.Fatalf("detail status/projection mismatch: %d", w.Code)
		}
		want := 0
		if id == rule.ID || id == other.ID {
			want = 1
		}
		if len(response.Rules) != want || (want == 1 && response.Rules[0].ID != id) {
			t.Fatal("detail widened identity")
		}
	}
	for _, q := range []string{"id=", "id=a&id=b", "id=%zz", "id=a%00b", "id=%20space", "id=a%EF%BB%BFb", "id=a&limit=20", "id=a&view=order", "id=a;view=order", "id=" + strings.Repeat("x", 513)} {
		w := routingCreateRequest(t, s, "GET", "/admin/routing-rules?"+q, "", "")
		if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), other.Note) || strings.Contains(w.Body.String(), other.ID) {
			t.Fatalf("invalid detail fell back to list, status=%d", w.Code)
		}
	}
	for _, q := range []string{"", "?legacy=ignored", "?view=order"} {
		w := routingCreateRequest(t, s, "GET", "/admin/routing-rules"+q, "", "")
		if w.Code != 200 {
			t.Fatalf("legacy collection/order changed: %d", w.Code)
		}
	}
	rows, err := db.ListRoutingRules(t.Context())
	audit, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || len(rows) != 2 || len(audit) != 0 || s.routingRules.Load() != cached {
		t.Fatal("read changed rules, routing cache or mutation audit")
	}
}

func TestResourceSearchRoutingScopedAuthorization(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-routing-search-session-fixture"
	if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: "route-billing", MatchPattern: "정산-*", TargetModel: "balanced", TargetProvider: "private-provider", Note: "private-note"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		scopes []string
		status int
	}{
		{"routing", []string{"routing:read"}, 200},
		{"admin", []string{"admin:read", "routing:read"}, 200},
		{"writer", []string{"routing:write"}, 403},
		{"security", []string{"security:read"}, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "routing-search-"+tc.name, "admin", "", tc.scopes, time.Now().UTC().Add(-time.Minute))
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["routing_rule"]}`, token)
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("scope status=%d want=%d", w.Code, tc.status)
			}
			if tc.status != 200 {
				return
			}
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || result.Groups[0].Status != "ok" || len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != "route-billing" {
				t.Fatal("scoped search failed")
			}
			for _, hidden := range []string{"private-note", "private-provider", "match_pattern", "min_complexity"} {
				if strings.Contains(w.Body.String(), hidden) {
					t.Fatal("search exposed non-navigation fields")
				}
			}
			detail := routingCreateRequest(t, s, "GET", "/admin/routing-rules?id=route-billing", "", token)
			if detail.Code != 200 {
				t.Fatalf("catalog/detail scope mismatch: %d", detail.Code)
			}
			if tc.name == "routing" {
				mixed := resourceSearchRequest(s, `{"query":"정산","kinds":["routing_rule","workflow"]}`, token)
				if mixed.Code != 200 || json.Unmarshal(mixed.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[0].Status != "ok" || result.Groups[1].Status != "forbidden" || len(result.Groups[1].Items) != 0 {
					t.Fatal("routing-only search inherited broader metadata permission")
				}
			}
		})
	}
	adminOnly := issueLLMScopedTestToken(t, db, s, "routing-search-admin-only", "admin", "", []string{"admin:read"}, time.Now().UTC().Add(-time.Minute))
	w := resourceSearchRequest(s, `{"query":"정산","kinds":["routing_rule"]}`, adminOnly)
	var denied struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &denied) != nil || len(denied.Groups) != 1 || denied.Groups[0].Status != "forbidden" || len(denied.Groups[0].Items) != 0 {
		t.Fatal("admin metadata read granted routing read")
	}
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.routing.rules.status", ValueJSON: `"hidden"`, ValueType: "string"}, "test", "fixture"); err != nil {
		t.Fatal(err)
	}
	token := issueLLMScopedTestToken(t, db, s, "routing-search-hidden", "admin", "", []string{"routing:read"}, time.Now().UTC().Add(-time.Minute))
	w = resourceSearchRequest(s, `{"query":"정산","kinds":["routing_rule"]}`, token)
	var result struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 {
		t.Fatal("hidden routing feature remained searchable")
	}
}

func TestRoutingRuleDetailReadScopeDoesNotGrantWrites(t *testing.T) {
	db, s, rule := routingCreateFixture(t)
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-routing-detail-session-fixture"
	for _, tc := range []struct {
		name   string
		scopes []string
		status int
	}{
		{"reader", []string{"admin:read", "routing:read"}, 200},
		{"routing-only", []string{"routing:read"}, 200},
		{"admin-only", []string{"admin:read"}, 401},
		{"writer-only", []string{"routing:write"}, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "routing-detail-"+tc.name, "admin", "", tc.scopes, time.Now().UTC().Add(-time.Minute))
			response := routingCreateRequest(t, s, "GET", "/admin/routing-rules?"+url.Values{"id": {rule.ID}}.Encode(), "", token)
			if response.Code != tc.status {
				t.Fatalf("read scope status=%d want=%d", response.Code, tc.status)
			}
			if tc.status != 200 && strings.Contains(response.Body.String(), rule.Note) {
				t.Fatal("denied detail leaked rule")
			}
			if tc.name == "reader" {
				denied := routingCreateRequest(t, s, "DELETE", "/admin/routing-rules/"+url.PathEscape(rule.ID), "", token)
				if denied.Code != 401 {
					t.Fatalf("readonly delete status=%d", denied.Code)
				}
				after, err := db.ListRoutingRulesByID(t.Context(), rule.ID)
				if err != nil || len(after) != 1 || after[0].Note != rule.Note {
					t.Fatal("denied mutation changed selected rule")
				}
			}
		})
	}
}
