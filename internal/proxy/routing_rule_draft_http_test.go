package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func routingDraftBody(t *testing.T, revision, model string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"rule_edit": map[string]any{"id": "order-z-first", "expected_revision": revision, "patch": map[string]any{"target_model": "public-draft-model"}},
		"request":   map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "public fixture"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func routingDraftWriteBody(t *testing.T, revision string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"expected_revision": revision, "patch": map[string]any{"target_model": "public-draft-model"}, "reason": "공개 검토 사유"})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestRoutingDraftHTTPReviewedWriteAndAudit(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	s.evaluateRoutingRules(t.Context(), "public-request", 0)
	response := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules/order-z-first?review=edit", routingDraftWriteBody(t, before.Revision), "")
	var ack struct {
		Rule     store.RoutingRule `json:"rule"`
		Revision string            `json:"revision"`
	}
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(response.Body.Bytes(), &ack) != nil || ack.Rule.TargetModel != "public-draft-model" || ack.Revision == before.Revision || s.routingRules.Load() != nil {
		t.Fatalf("invalid reviewed write acknowledgment: %d", response.Code)
	}
	stored, err := db.GetRoutingOrderSnapshot(t.Context())
	if err != nil || stored.Revision != ack.Revision {
		t.Fatal("ACK differs from committed rules")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "routing_rule.reviewed_update" || !strings.Contains(audits[0].AfterValue, "공개 검토 사유") {
		t.Fatal("missing reviewed change audit")
	}
	retry := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules/order-z-first?review=edit", routingDraftWriteBody(t, before.Revision), "")
	if retry.Code != 409 {
		t.Fatal("stale reviewed write replay accepted")
	}
}

func TestRoutingDraftHTTPStrictInputs(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	valid := routingDraftBody(t, before.Revision, "public-request")
	for _, body := range []string{
		strings.Replace(valid, `"target_model":`, `"enabled":true,"target_model":`, 1),
		strings.Replace(valid, `"target_model":"public-draft-model"`, `"target_model":null`, 1),
		strings.Replace(valid, `"target_model":`, `"target_model":"duplicate","target_model":`, 1),
		strings.Replace(valid, `"patch":`, `"patch":{},"patch":`, 1),
		strings.Replace(valid, `"role":"user"`, `"role":null`, 1),
		strings.Replace(valid, `"content":"public fixture"`, `"content":null`, 1),
		strings.Replace(valid, `"model":"public-request"`, `"model":""`, 1),
		strings.Replace(valid, `"role":"user"`, `"role":"tool"`, 1),
		strings.Replace(valid, `"messages":`, `"tools":[],"messages":`, 1),
		valid + `{}`, valid[:len(valid)-1] + `,"rule_order":[]}`,
	} {
		response := routingCreateRequest(t, s, "POST", "/admin/routing/preview", body, "")
		if response.Code != 400 {
			t.Fatalf("invalid draft accepted: %d", response.Code)
		}
	}
	for _, query := range []string{"?review=edit&review=edit", "?review=other", "?review=edit&extra=1", "?review=edit&bad=%xx"} {
		response := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules/order-z-first"+query, routingDraftWriteBody(t, before.Revision), "")
		if response.Code != 400 {
			t.Fatalf("invalid write query accepted: %d", response.Code)
		}
	}
	after, err := db.GetRoutingOrderSnapshot(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(audits) != 0 {
		t.Fatal("invalid draft changed persisted state")
	}
}

func TestRoutingDraftHTTPPermissionBoundary(t *testing.T) {
	for _, tc := range []struct {
		name        string
		scopes      []string
		read, write int
	}{
		{"read", []string{"routing:read"}, 200, 401},
		{"write", []string{"routing:write"}, 401, 401},
		{"both", []string{"routing:read", "routing:write"}, 200, 200},
		{"generic", []string{"admin:read", "admin:write"}, 401, 401},
		{"none", nil, 401, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, before := routingOrderFixture(t)
			s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-draft-jwt-secret"
			token := issueLLMScopedTestToken(t, db, s, tc.name, "operator", "", tc.scopes, time.Now().UTC())
			read := routingCreateRequest(t, s, "POST", "/admin/routing/preview", routingDraftBody(t, before.Revision, "public-request"), token)
			write := routingCreateRequest(t, s, "PATCH", "/admin/routing-rules/order-z-first?review=edit", routingDraftWriteBody(t, before.Revision), token)
			if read.Code != tc.read || write.Code != tc.write {
				t.Fatalf("scope read/write=%d/%d", read.Code, write.Code)
			}
		})
	}
}

func TestRoutingDraftHTTPPolicyKeyTeamScope(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: "draft-team", Name: "draft-team"}); err != nil {
		t.Fatal(err)
	}
	for _, team := range []string{"draft-team", "other-team"} {
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: team + "-key", Name: "public-policy", KeyHash: hashProxyKey("public-fixture-" + team), Status: "active", Team: team, AllowedModels: []string{"gpt-4.1-mini"}}); err != nil {
			t.Fatal(err)
		}
	}
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-draft-team-jwt"
	token := issueLLMScopedTestToken(t, db, s, "team-reviewer", "team_admin", "draft-team", []string{"routing:read"}, time.Now().UTC())
	for _, tc := range []struct {
		team   string
		status int
	}{{"draft-team", 200}, {"other-team", 403}, {"missing", 404}} {
		body := strings.Replace(routingDraftBody(t, before.Revision, "vibe/auto"), `"request":{`, `"request":{"api_key_id":"`+tc.team+`-key",`, 1)
		response := routingCreateRequest(t, s, "POST", "/admin/routing/preview", body, token)
		if response.Code != tc.status {
			t.Fatalf("policy key scope status=%d want=%d", response.Code, tc.status)
		}
		if tc.status == 200 {
			var result struct {
				Before, After struct {
					Model string `json:"selected_model"`
				}
			}
			if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Before.Model != "gpt-4.1-mini" || result.After.Model != "gpt-4.1-mini" {
				t.Fatal("draft comparison lost the current policy model scope")
			}
		}
	}
}

func TestRoutingDraftHTTPComparesFullPlanWithoutWriting(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	s.evaluateRoutingRules(t.Context(), "public-request", 0)
	cached := s.routingRules.Load()
	response := routingCreateRequest(t, s, "POST", "/admin/routing/preview", routingDraftBody(t, before.Revision, "public-request"), "")
	var result struct {
		Stage    string `json:"stage"`
		Revision string `json:"revision"`
		Before   struct {
			Model    string   `json:"selected_model"`
			Fallback []string `json:"fallback_plan"`
		} `json:"before"`
		After struct {
			Model    string   `json:"selected_model"`
			Fallback []string `json:"fallback_plan"`
		} `json:"after"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Stage != "routing_plan" || result.Revision != before.Revision || result.Before.Model != "order-z-first" || result.After.Model != "public-draft-model" || len(result.Before.Fallback) == 0 || len(result.After.Fallback) == 0 {
		t.Fatalf("missing unsaved full-plan comparison, status=%d", response.Code)
	}
	after, err := db.GetRoutingOrderSnapshot(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(audits) != 0 || s.routingRules.Load() != cached {
		t.Fatal("preview changed rules, audit or routing cache")
	}
}

func TestRoutingDraftHTTPRespectsAutoAlias(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	rule := before.Rules[1]
	rule.MatchPattern = "*"
	if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
		t.Fatal(err)
	}
	before, _ = db.GetRoutingOrderSnapshot(t.Context())
	response := routingCreateRequest(t, s, "POST", "/admin/routing/preview", routingDraftBody(t, before.Revision, "vibe/auto"), "")
	var result struct {
		Before, After struct {
			Model  string `json:"selected_model"`
			Reason string `json:"route_reason"`
		}
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Before.Reason != "auto_router" || result.After.Reason != "auto_router" || result.Before.Model != result.After.Model || result.After.Model == "public-draft-model" {
		t.Fatal("comparison confused the isolated rule stage with the full auto plan")
	}
}

func TestRoutingDraftHTTPRejectsStaleSnapshot(t *testing.T) {
	db, s, before := routingOrderFixture(t)
	if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: "public-other", Priority: 1, TargetModel: "public-new"}); err != nil {
		t.Fatal(err)
	}
	response := routingCreateRequest(t, s, "POST", "/admin/routing/preview", routingDraftBody(t, before.Revision, "public-request"), "")
	if response.Code != 409 {
		t.Fatalf("stale snapshot accepted: %d", response.Code)
	}
}
