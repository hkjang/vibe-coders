package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Existing-contract controls, not UI/CAS/idempotency or atomic-audit proofs.
// Reuse the apply fixture's explicit temporary SQLite, real Routes, scoped JWTs,
// loopback upstream sentinel (cleanup requires zero calls), one unrelated policy
// and setting. No external database opt-in or production provider is consulted.
func TestPolicyEditorHTTPReplacesMultipleRulesAndPreservesOtherConfiguration(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	before := f.unchangedConfiguration(t)
	policyEditorPost(t, f, `{"id":"editor-target","name":"original","description":"original description","enabled":false,"priority":17,"rollout_percent":25,"rules":[{"id":"edit-rule","name":"edit","enabled":true,"priority":10,"conditions":{"model":"before"},"actions":{"block":true}},{"id":"keep-rule","name":"keep","enabled":false,"priority":20,"conditions":{"unknown":{"MixedCase":["public",7,null]}},"actions":{"future":["public-action"]}},{"id":"remove-rule","name":"remove","conditions":{},"actions":{"block":true}}]}`)
	old := f.policy(t, "editor-target")
	ack := policyEditorPost(t, f, `{"id":"editor-target","name":"reviewed","description":"reviewed description","enabled":false,"priority":19,"rollout_percent":25,"rules":[{"id":"edit-rule","name":"edited","enabled":true,"priority":11,"conditions":{"model":"after"},"actions":{"require_approval":true}},{"id":"keep-rule","name":"keep","enabled":false,"priority":20,"conditions":{"unknown":{"MixedCase":["public",7,null]}},"actions":{"future":["public-action"]}},{"name":"added","enabled":true,"priority":30,"conditions":{"risk_score":">=70"},"actions":{"block":true}}]}`)
	p := policyEditorRead(t, f, "editor-target")
	if p.ID != old.ID || p.Name != "reviewed" || p.Description != "reviewed description" || p.Enabled || p.Priority != 19 || p.RolloutPercent != 25 || !p.CreatedAt.Equal(old.CreatedAt) || len(p.Rules) != 3 {
		t.Fatal("same policy must retain identity/creation time and store the submitted disabled metadata and three rules")
	}
	if ack.ID != p.ID || ack.Enabled || len(ack.Rules) != 3 {
		t.Fatal("201 acknowledgement must identify the submitted disabled policy and decoded rules")
	}
	rules := map[string]store.PolicyRule{}
	for _, r := range p.Rules {
		rules[r.ID] = r
		if r.PolicyID != p.ID || r.ID == "remove-rule" {
			t.Fatal("deleted rule survived or rule ownership changed")
		}
	}
	if rules["edit-rule"].Conditions["model"] != "after" || rules["edit-rule"].Actions["require_approval"] != true {
		t.Fatal("existing rule conditions/actions were not updated")
	}
	var previousKept store.PolicyRule
	for _, r := range old.Rules {
		if r.ID == "keep-rule" {
			previousKept = r
		}
	}
	kept := rules["keep-rule"]
	if kept.Name != previousKept.Name || kept.Enabled != previousKept.Enabled || kept.Priority != previousKept.Priority || !reflect.DeepEqual(kept.Conditions, previousKept.Conditions) || !reflect.DeepEqual(kept.Actions, previousKept.Actions) {
		t.Fatal("resubmitted untouched rule values must survive, including unknown nested JSON")
	}
	added := p.Rules[2]
	if added.ID == "" || added.Name != "added" || added.ID == "edit-rule" || added.ID == "keep-rule" {
		t.Fatal("new rule needs a server-generated distinct identity")
	}
	active, err := f.db.ActivePolicyRules(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range active {
		if r.PolicyID == p.ID {
			t.Fatal("editing a disabled policy must not activate its enabled rules")
		}
	}
	if f.unchangedConfiguration(t) != before || len(policyEditorAudits(t, f)) != 2 {
		t.Fatal("unrelated policy/settings changed or successful upsert audit missing")
	}
}

func TestPolicyEditorHTTPEmptyAndLegacyRulesReplaceRatherThanPatch(t *testing.T) {
	for _, tc := range []struct{ name, suffix string }{
		{"empty_array", `,"rules":[]`},
		{"omitted", ``},
		{"null", `,"rules":null`},
		{"wrong_object", `,"rules":{}`},
		{"non_objects_skipped", `,"rules":[null,false,7,"rule"]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPolicyAdvisorApplyHTTPFixture(t, false)
			policyEditorPost(t, f, `{"id":"replace-target","enabled":false,"rules":[{"id":"old-rule","actions":{"block":true}}]}`)
			policyEditorPost(t, f, `{"id":"replace-target","enabled":false`+tc.suffix+`}`)
			if len(policyEditorRead(t, f, "replace-target").Rules) != 0 {
				t.Fatal("empty/malformed rules without legacy conditions/actions must replace the old list with no rules")
			}
		})
	}
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	policyEditorPost(t, f, `{"id":"legacy-target","enabled":false,"rules":null,"model":"public-model","block":true}`)
	p := policyEditorRead(t, f, "legacy-target")
	if len(p.Rules) != 1 || p.Rules[0].Conditions["model"] != "public-model" || p.Rules[0].Actions["block"] != true {
		t.Fatal("legacy top-level conditions/actions must still decode one replacement rule")
	}
}

func TestPolicyEditorHTTPZeroRulesAreOmittedFromRawACKAndGET(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	const id = "wire-empty-policy"
	policyEditorPost(t, f, `{"id":"wire-empty-policy","enabled":false,"rules":[{"id":"wire-old-rule","actions":{"block":true}}]}`)
	data := f.request(t, http.MethodPost, "/admin/policies", f.adminToken,
		`{"id":"wire-empty-policy","enabled":false,"rules":[]}`, http.StatusCreated)
	var ack struct {
		Policy map[string]json.RawMessage `json:"policy"`
	}
	if err := json.Unmarshal(data, &ack); err != nil {
		t.Fatal(err)
	}
	assertOmitted := func(label string, fields map[string]json.RawMessage) {
		t.Helper()
		var gotID string
		if err := json.Unmarshal(fields["id"], &gotID); err != nil || gotID != id || string(fields["enabled"]) != "false" {
			t.Fatalf("%s must identify the disabled target policy", label)
		}
		if _, exists := fields["rules"]; exists {
			t.Fatalf("%s zero-rule policy must omit rules, not emit null or []", label)
		}
	}
	assertOmitted("POST acknowledgement", ack.Policy)
	token := issueLLMScopedTestToken(t, f.db, f.server, newID("policy-reader"), "contract_operator", "", []string{"security:read"}, time.Now().UTC())
	data = f.request(t, http.MethodGet, "/admin/policies", token, "", http.StatusOK)
	var response struct {
		Policies []map[string]json.RawMessage `json:"policies"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		t.Fatal(err)
	}
	for _, fields := range response.Policies {
		var gotID string
		if err := json.Unmarshal(fields["id"], &gotID); err != nil {
			t.Fatal(err)
		}
		if gotID == id {
			assertOmitted("GET policy", fields)
			return
		}
	}
	t.Fatal("zero-rule target missing from GET policy list")
}

func TestPolicyEditorHTTPNormalizationDefaultsAndOpaqueIDs(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	ack := policyEditorPost(t, f, `{"id":" \u0085editor /% id \u0085 ","name":" \u0085 ","description":" \u0085public description\u0085 ","enabled":null,"priority":0,"rollout_percent":250,"rules":[{"id":" . ","name":" \ufeffpublic\ufeff ","priority":0,"conditions":{" MODEL ":"sk-public-synthetic-value"," Future ":{"MixedCase":[1,null,true]}},"actions":{" BLOCK ":true,"Unknown":false}}]}`)
	p := policyEditorRead(t, f, "editor /% id")
	if p.Name != p.ID || p.Description != "public description" || p.Enabled || p.Priority != 100 || p.RolloutPercent != 100 || ack.RolloutPercent != 250 {
		t.Fatal("trim/fallback/null/defaults or decoded-ACK versus stored rollout distinction changed")
	}
	r := p.Rules[0]
	if r.ID != "." || r.Name != "\ufeffpublic\ufeff" || !r.Enabled || r.Priority != 100 || r.Conditions["model"] != "sk-public-synthetic-value" || r.Actions["block"] != true || r.Actions["unknown"] != false {
		t.Fatal("rule defaults, opaque IDs, FEFF preservation or top-level JSON-key normalization changed")
	}
	if !reflect.DeepEqual(r.Conditions["future"], map[string]any{"MixedCase": []any{float64(1), nil, true}}) {
		t.Fatal("unknown nested keys/values must survive; only condition/action outer keys are normalized")
	}
	for _, tc := range []struct {
		name, number string
		want         int
	}{
		{"fractional_fallback", "1.5", 100},
		{"null_fallback", "null", 100},
		{"numeric_string", `" 23 "`, 23},
		{"negative_preserved", "-7", -7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := policyEditorPost(t, f, `{"name":"defaults","priority":`+tc.number+`,"rules":[{"priority":`+tc.number+`}]}`)
			stored := policyEditorRead(t, f, p.ID)
			if p.ID == "" || !stored.Enabled || stored.Priority != tc.want || len(stored.Rules) != 1 || !stored.Rules[0].Enabled || stored.Rules[0].Priority != tc.want {
				t.Fatal("existing loose priority/default-enabled contract changed")
			}
		})
	}
	first := policyEditorPost(t, f, `{"id":17,"name":"generated one","enabled":false,"rules":[]}`)
	second := policyEditorPost(t, f, `{"id":17,"name":"generated two","enabled":false,"rules":[]}`)
	if first.ID == "17" || first.ID == second.ID {
		t.Fatal("unsupported numeric ID decodes as empty and generates a new policy; not a validation error/idempotency key")
	}
}

func TestPolicyEditorHTTPInvalidJSONAndRuleIDConflictDoNotPartiallyReplace(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	policyEditorPost(t, f, `{"id":"atomic-target","name":"original","enabled":false,"rules":[{"id":"original-rule","actions":{"block":true}}]}`)
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"invalid_json", `{"id":`, http.StatusBadRequest},
		{"array_root", `[]`, http.StatusBadRequest},
		{"duplicate_rule_id", `{"id":"atomic-target","name":"must rollback","enabled":false,"rules":[{"id":"same-rule"},{"id":"same-rule"}]}`, http.StatusInternalServerError},
		{"other_policy_rule_id", `{"id":"atomic-target","name":"must rollback","enabled":false,"rules":[{"id":"kept-rule"}]}`, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := policyEditorState(t, f)
			f.request(t, http.MethodPost, "/admin/policies", f.adminToken, tc.body, tc.status)
			if policyEditorState(t, f) != before {
				t.Fatal("rejected parse/transaction changed policy/rules/settings/upsert audit")
			}
		})
	}
	// No optimistic version is read by this endpoint: ordinary sequential latest
	// submissions replace one row, not a concurrency/CAS guarantee.
	policyEditorPost(t, f, `{"id":"atomic-target","name":"later","enabled":false,"expected_version":-1,"rules":[]}`)
	if p := policyEditorRead(t, f, "atomic-target"); p.Name != "later" || len(p.Rules) != 0 {
		t.Fatal("unknown expected_version must not invent a server CAS contract")
	}
}

func TestPolicyEditorHTTPReadWriteScopesAndRawAuditContract(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	p := policyEditorPost(t, f, `{"id":"raw-target","name":"public","enabled":false,"rules":[{"name":"raw","conditions":{"future":"sk-public-synthetic-marker"},"actions":{"unknown":true}}]}`)
	// security:read suffices for this complete raw policy GET. admin:write alone
	// suffices for POST; neither claim is a raw-prompt grant or UI route policy.
	if got := policyEditorRead(t, f, p.ID); got.Rules[0].Conditions["future"] != "sk-public-synthetic-marker" {
		t.Fatal("existing security:read policy GET must not be mistaken for a masked DTO")
	}
	for _, scopes := range [][]string{{"admin:read"}, {"security:read"}, {}} {
		t.Run("post_denied_"+policySimulationScopeLabel(scopes), func(t *testing.T) {
			token := issueLLMScopedTestToken(t, f.db, f.server, t.Name(), "contract_operator", "", scopes, time.Now().UTC())
			before := policyEditorState(t, f)
			f.request(t, http.MethodPost, "/admin/policies", token, `{"id":"raw-target","enabled":true}`, http.StatusUnauthorized)
			if policyEditorState(t, f) != before {
				t.Fatal("denied POST changed policy/config/upsert audit (authentication audits are outside this snapshot)")
			}
		})
	}
	for _, scopes := range [][]string{{"admin:read"}, {"admin:write"}, {}} {
		token := issueLLMScopedTestToken(t, f.db, f.server, "get-"+policySimulationScopeLabel(scopes), "contract_operator", "", scopes, time.Now().UTC())
		f.request(t, http.MethodGet, "/admin/policies", token, "", http.StatusUnauthorized)
	}
	rows := policyEditorAudits(t, f)
	if len(rows) != 1 || rows[0].BeforeValue != "" || !strings.HasPrefix(rows[0].AdminID, "admin_") {
		t.Fatal("upsert audit uses a server actor and empty before-value, not atomic before/after diff")
	}
	var recorded store.Policy
	if err := json.Unmarshal([]byte(rows[0].AfterValue), &recorded); err != nil || recorded.ID != p.ID || recorded.Rules[0].Conditions["future"] != "sk-public-synthetic-marker" {
		t.Fatal("audit must retain the existing raw synthetic rule contract")
	}
}

func TestPolicyEditorHTTPPostChangeCanRecordDryRunAndSeedSetting(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, true)
	before := f.unchangedConfiguration(t, "redteam.seed_version")
	p := policyEditorPost(t, f, `{"id":"dry-run-target","name":"public disabled edit","enabled":false,"rules":[{"conditions":{"model":"public-local-model"},"actions":{"block":true}}]}`)
	campaigns, err := f.db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatalf("post-change campaigns=%d err=%v", len(campaigns), err)
	}
	c := campaigns[0]
	if c.TriggerAction != "governance.policy.upsert" || c.TriggerRef != p.ID || c.ExecutionMode != "dry-run" || c.ExternalProviderAllowed || c.Status != "completed" {
		t.Fatal("existing post-change path must remain a recorded local dry-run, not an upstream execution")
	}
	seed, found, err := f.db.GetAdminSetting(t.Context(), "redteam.seed_version")
	if err != nil || !found || seed.ValueJSON != "2" || seed.Source != "system" {
		t.Fatal("first post-change check may initialize the existing seed-version system setting")
	}
	if f.unchangedConfiguration(t, "redteam.seed_version") != before || f.policy(t, p.ID).Enabled {
		t.Fatal("post-change processing changed unrelated policy/settings or enabled the edited policy")
	}
	// A successful response is after the policy transaction; audit and post-change
	// work are separate best-effort steps, not an all-database atomicity promise.
}

func policyEditorPost(t *testing.T, f *policyAdvisorApplyHTTPFixture, body string) store.Policy {
	t.Helper()
	data := f.request(t, http.MethodPost, "/admin/policies", f.adminToken, body, http.StatusCreated)
	var ack struct {
		Policy *store.Policy `json:"policy"`
	}
	if err := json.Unmarshal(data, &ack); err != nil || ack.Policy == nil || ack.Policy.ID == "" {
		t.Fatalf("201 must contain a policy acknowledgement: err=%v", err)
	}
	return *ack.Policy
}

func policyEditorRead(t *testing.T, f *policyAdvisorApplyHTTPFixture, id string) store.Policy {
	t.Helper()
	token := issueLLMScopedTestToken(t, f.db, f.server, newID("policy-reader"), "contract_operator", "", []string{"security:read"}, time.Now().UTC())
	data := f.request(t, http.MethodGet, "/admin/policies", token, "", http.StatusOK)
	var got struct {
		Policies []store.Policy `json:"policies"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	for _, p := range got.Policies {
		if p.ID == id {
			return p
		}
	}
	t.Fatal("saved policy missing from actual GET")
	return store.Policy{}
}

func policyEditorAudits(t *testing.T, f *policyAdvisorApplyHTTPFixture) []store.AdminAuditPublic {
	t.Helper()
	rows, err := f.db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal(err)
	}
	selected := []store.AdminAuditPublic{}
	for _, row := range rows {
		if row.Action == "governance.policy.upsert" {
			selected = append(selected, row)
		}
	}
	return selected
}

func policyEditorState(t *testing.T, f *policyAdvisorApplyHTTPFixture) string {
	t.Helper()
	policies, err := f.db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal([]any{policies, f.unchangedConfiguration(t), policyEditorAudits(t, f)})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
