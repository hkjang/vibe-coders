package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func routingOrderFixture(t *testing.T) (*store.SQLStore, *Server, store.RoutingOrderSnapshot) {
	t.Helper()
	db, s, _ := routingCreateFixture(t)
	for i, id := range []string{"order-z-first", "order-a-second"} {
		if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: id, Enabled: true, Priority: 20,
			MatchPattern: "public-*", MaxComplexity: 100, TargetModel: id, Note: "preserve note",
			CreatedAt: time.Date(2026, 11, 1, 0, 0, 0, i+1, time.UTC)}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := db.GetRoutingOrderSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return db, s, before
}

func routingOrderBody(t *testing.T, before store.RoutingOrderSnapshot, preview bool) string {
	t.Helper()
	ids := []string{"order-a-second", "order-z-first", "create-other"}
	var value any = routingOrderInput{Order: ids, ExpectedRevision: before.Revision, Reason: "검증된 처리 순서 적용"}
	if preview {
		value = routingOrderPreviewInput{Model: "public-request", Complexity: 50, Order: ids, Revision: before.Revision}
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestRoutingOrderHTTPPreviewCommitAndCache(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	if got := s.evaluateRoutingRules(t.Context(), "public-request", 50); got.TargetModel != "order-z-first" {
		t.Fatal("unexpected live baseline")
	}
	cached := s.routingRules.Load()
	get := routingCreateRequest(t, s, "GET", "/admin/routing-rules?view=order", "", "")
	var snapshot store.RoutingOrderSnapshot
	if get.Code != 200 || get.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(get.Body.Bytes(), &snapshot) != nil || !reflect.DeepEqual(before, snapshot) {
		t.Fatal("review snapshot differs from stored configuration")
	}
	preview := routingCreateRequest(t, s, "POST", "/admin/routing/preview", routingOrderBody(t, before, true), "")
	var comparison struct {
		Stage    string                      `json:"stage"`
		Revision string                      `json:"revision"`
		Before   routingOrderPreviewDecision `json:"before"`
		After    routingOrderPreviewDecision `json:"after"`
	}
	if preview.Code != 200 || preview.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(preview.Body.Bytes(), &comparison) != nil || comparison.Stage != "complexity_rules" || comparison.Revision != before.Revision || comparison.Before.MatchedRuleID != "order-z-first" || comparison.After.MatchedRuleID != "order-a-second" || !comparison.Before.Applied || !comparison.After.Applied {
		t.Fatal("stage comparison does not explain before and after rule selection")
	}
	if s.routingRules.Load() != cached {
		t.Fatal("read-only comparison changed live cache")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("preview created a mutation audit")
	}
	write := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules", routingOrderBody(t, before, false), "")
	if write.Code != 200 || write.Header().Get("Cache-Control") != "no-store" || s.routingRules.Load() != nil {
		t.Fatalf("write/cache: status %d", write.Code)
	}
	var after store.RoutingOrderSnapshot
	if json.Unmarshal(write.Body.Bytes(), &after) != nil || after.Revision == before.Revision {
		t.Fatal("write did not acknowledge changed revision")
	}
	stored, err := db.GetRoutingOrderSnapshot(t.Context())
	if err != nil || !reflect.DeepEqual(after, stored) {
		t.Fatal("acknowledgment differs from persistence")
	}
	if got := s.evaluateRoutingRules(t.Context(), "public-request", 50); got.TargetModel != comparison.After.TargetModel {
		t.Fatal("live evaluator differs from reviewed comparison")
	}
	audits, err = db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "routing_rule.reorder" || !strings.Contains(audits[0].AfterValue, "검증된 처리 순서 적용") || strings.Contains(audits[0].AfterValue, "preserve note") {
		t.Fatal("order audit must contain priorities and reason only")
	}
	for _, path := range []string{"/admin/routing-rules", "/admin/routing/preview"} {
		method := "PATCH"
		isPreview := strings.HasSuffix(path, "preview")
		if isPreview {
			method = "POST"
		}
		w := routingCreateRequest(t, s, method, path, routingOrderBody(t, before, isPreview), "")
		if w.Code != 409 {
			t.Fatalf("stale review accepted: %s %d", path, w.Code)
		}
	}
}

func TestRoutingOrderHTTPPermissionContract(t *testing.T) {
	for _, tc := range []struct {
		name, mode  string
		scopes      []string
		read, write int
	}{
		{"routing_read", "jwt", []string{"routing:read"}, 200, 401},
		{"routing_write", "jwt", []string{"routing:write"}, 401, 401},
		{"routing_both", "jwt", []string{"routing:read", "routing:write"}, 200, 200},
		{"admin_both", "jwt", []string{"admin:read", "admin:write"}, 401, 401},
		{"no_scopes", "jwt", nil, 401, 401},
		{"missing", "missing", nil, 401, 401},
		{"legacy_read", "readonly", nil, 200, 401},
		{"legacy_full", "legacy", nil, 200, 200},
		{"open", "open", nil, 200, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, before := routingOrderFixture(t)
			token := ""
			switch tc.mode {
			case "jwt", "missing":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-order-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, "operator", "", tc.scopes, time.Now().UTC())
				}
			case "readonly", "legacy":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "synthetic-order-full", "synthetic-order-read"
				token = s.cfg.Auth.AdminReadonlyToken
				if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			for _, path := range []string{"/admin/routing-rules?view=order", "/admin/routing/preview"} {
				method, body := "GET", ""
				if strings.HasSuffix(path, "preview") {
					method, body = "POST", routingOrderBody(t, before, true)
				}
				w := routingCreateRequest(t, s, method, path, body, token)
				want := tc.read
				// Preserve existing legacy-token authorization: its readonly token
				// permits GET, but still rejects POST even for ordinary preview.
				if tc.mode == "readonly" && method == "POST" {
					want = 401
				}
				if w.Code != want {
					t.Fatalf("read %s status=%d", path, w.Code)
				}
			}
			write := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules", routingOrderBody(t, before, false), token)
			if write.Code != tc.write {
				t.Fatalf("write status=%d", write.Code)
			}
			if tc.write != 200 {
				after, err := db.GetRoutingOrderSnapshot(t.Context())
				audits, auditErr := db.ListAdminAudit(t.Context(), 10)
				if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(audits) != 0 {
					t.Fatal("denied write changed configuration")
				}
			}
		})
	}
}

func TestRoutingOrderHTTPStrictInputs(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	valid := routingOrderBody(t, before, false)
	for _, body := range []string{
		`null`, `[]`, `{}`, valid + `{}`, strings.Replace(valid, `"order":`, `"ORDER":`, 1),
		strings.Replace(valid, `"reason":`, `"reason":"duplicate","reason":`, 1),
		strings.Replace(valid, `"검증된 처리 순서 적용"`, `null`, 1),
		strings.Replace(valid, `"검증된 처리 순서 적용"`, `"  "`, 1),
		strings.Replace(valid, `"검증된 처리 순서 적용"`, `"`+strings.Repeat("가", 501)+`"`, 1),
		strings.Replace(valid, `"order-a-second"`, `"create-other"`, 1),
		strings.Replace(valid, `"order-a-second",`, ``, 1),
		strings.Replace(valid, `"order-a-second"`, `"not-present"`, 1),
		valid[:len(valid)-1] + `,"extra":true}`, strings.Repeat(" ", routingOrderBodyLimit+1),
	} {
		w := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules", body, "")
		if w.Code != 400 {
			t.Fatalf("invalid body returned %d", w.Code)
		}
	}
	for _, query := range []string{"?view=order&view=order", "?view=order&extra=true", "?view=order&bad=%xx"} {
		w := routingCreateRequest(t, s, "GET", "/admin/routing-rules"+query, "", "")
		if w.Code != 400 {
			t.Fatalf("invalid snapshot query returned %d", w.Code)
		}
	}
	preview := routingOrderBody(t, before, true)
	for _, body := range []string{strings.Replace(preview, `"complexity":50`, `"complexity":101`, 1), strings.Replace(preview, `"complexity":50`, `"complexity":null`, 1), strings.Replace(preview, `"model":"public-request"`, `"model":""`, 1), `{"rule_revision":"missing-other-fields"}`, preview[:len(preview)-1] + `,"api_key_id":"must-not-enter-user-planner"}`} {
		w := routingCreateRequest(t, s, "POST", "/admin/routing/preview", body, "")
		if w.Code != 400 {
			t.Fatalf("invalid order comparison returned %d", w.Code)
		}
	}
	after, err := db.GetRoutingOrderSnapshot(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(audits) != 0 {
		t.Fatal("invalid order operation mutated state")
	}
}

func TestRoutingOrderEvaluatorNoOpStopsAndDisabledSkips(t *testing.T) {
	_, s, before := routingOrderFixture(t)
	rules := before.Rules
	for _, target := range []string{"", "public-request"} {
		rules[1].TargetModel = target
		decision, id := evaluateRoutingRuleOrder(rules, " public-request ", 50)
		if decision.Applied || id != "order-z-first" {
			t.Fatal("no-op match must stop later rules")
		}
	}
	rules[1].Enabled = false
	decision, id := evaluateRoutingRuleOrder(rules, "PUBLIC-request", 50)
	if !decision.Applied || id != "order-a-second" {
		t.Fatal("disabled rules must not stop selection")
	}
	s.routingRules.Store(&routingRulesSnapshot{rules: rules, fetchedAt: time.Now()})
	if got := s.evaluateRoutingRules(t.Context(), "PUBLIC-request", 50); got != decision {
		t.Fatal("live evaluator differs from comparison evaluator")
	}
}
