package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These are existing-contract controls through actual Routes and temporary
// SQLite. They do not prove UI guards, atomic audit, idempotency, or a generally
// side-effect-free operation. All configured upstreams are the local sentinel.
func TestPolicyAdvisorApplyHTTPCreatesDisabledDraftAndPreservesRawRule(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	before := f.unchangedConfiguration(t)
	body := `{"title":"  공개 초안  ","conditions":{"model":"public-model","unknown":{"raw":"sk-public-synthetic-marker"}},"actions":{"block":true,"unknown":["public-value",7]},"id":"kept-policy","enabled":true}`
	id := f.apply(t, body)
	p := f.policy(t, id)
	if id == "kept-policy" || p.Name != "[draft] 공개 초안" || p.Enabled || p.Priority != 100 || p.RolloutPercent != 100 {
		t.Fatalf("unexpected disabled draft metadata: %+v", p)
	}
	if p.Description != "Policy Advisor 추천 (검토 후 활성화)" || p.CreatedAt.IsZero() || p.UpdatedAt.IsZero() || len(p.Rules) != 1 {
		t.Fatal("draft must have server metadata and exactly one rule")
	}
	rule := p.Rules[0]
	if rule.ID == "" || rule.PolicyID != id || rule.Name != "공개 초안" || !rule.Enabled || rule.Priority != 100 {
		t.Fatalf("unexpected draft rule metadata: %+v", rule)
	}
	var sent struct {
		Conditions map[string]any `json:"conditions"`
		Actions    map[string]any `json:"actions"`
	}
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rule.Conditions, sent.Conditions) || !reflect.DeepEqual(rule.Actions, sent.Actions) {
		t.Fatal("unknown rule vocabulary/raw synthetic values must not be silently projected or dropped")
	}
	active, err := f.db.ActivePolicyRules(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range active {
		if current.PolicyID == id {
			t.Fatal("enabled rule inside disabled policy must not become active")
		}
	}
	audits := f.applyAudits(t)
	if len(audits) != 1 || audits[0].BeforeValue != "" || !strings.HasPrefix(audits[0].AdminID, "admin_") {
		t.Fatalf("expected one apply audit with server-derived actor, got %d", len(audits))
	}
	var after struct {
		PolicyID   string         `json:"policy_id"`
		Title      string         `json:"title"`
		Conditions map[string]any `json:"conditions"`
		Actions    map[string]any `json:"actions"`
	}
	if err := json.Unmarshal([]byte(audits[0].AfterValue), &after); err != nil {
		t.Fatal(err)
	}
	if after.PolicyID != id || after.Title != "공개 초안" || !reflect.DeepEqual(after.Conditions, sent.Conditions) || !reflect.DeepEqual(after.Actions, sent.Actions) {
		t.Fatal("audit retains raw rule payload; UI-only masking is not a storage/audit redaction contract")
	}
	if f.unchangedConfiguration(t) != before {
		t.Fatal("draft creation changed existing policy, settings, or setting history")
	}
}

func TestPolicyAdvisorApplyHTTPRepeatedBodyCreatesDistinctDrafts(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	body := `{"title":"same recommendation","conditions":{"model":"public-model"},"actions":{"require_approval":true}}`
	first, second := f.apply(t, body), f.apply(t, body)
	if first == second || f.policy(t, first).Name != f.policy(t, second).Name || len(f.applyAudits(t)) != 2 {
		t.Fatal("normal repeated submissions should create distinct draft identities and audits, not idempotently reuse one")
	}
	rows, err := f.db.ListPolicies(t.Context())
	if err != nil || len(rows) != 3 {
		t.Fatalf("policy rows = %d, err=%v; want existing plus two drafts", len(rows), err)
	}
}

func TestPolicyAdvisorApplyHTTPTitleAndBodyContract(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	for _, tc := range []struct{ name, body, want string }{
		{"title_omitted", `{"actions":{"block":true}}`, "advisor 추천 정책"},
		{"title_null", `{"title":null,"conditions":null,"actions":{"block":true}}`, "advisor 추천 정책"},
		{"title_empty", `{"title":"","actions":{"block":true}}`, "advisor 추천 정책"},
		{"title_go_whitespace", `{"title":" \t\r\n\u0085 ","actions":{"block":true}}`, "advisor 추천 정책"},
		{"title_feff_preserved", `{"title":"\ufeffpublic\ufeff","actions":{"block":true}}`, "\ufeffpublic\ufeff"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := f.policy(t, f.apply(t, tc.body))
			if p.Name != "[draft] "+tc.want || len(p.Rules) != 1 || p.Rules[0].Name != tc.want || len(p.Rules[0].Conditions) != 0 {
				t.Fatal("server title trim/fallback or omitted/null conditions contract changed")
			}
		})
	}
	for _, tc := range []struct{ name, body, code string }{
		{"actions_omitted", `{}`, "no_actions"},
		{"actions_null", `{"actions":null}`, "no_actions"},
		{"actions_empty", `{"actions":{}}`, "no_actions"},
		{"title_wrong_type", `{"title":12,"actions":{"block":true}}`, "invalid_body"},
		{"conditions_wrong_type", `{"conditions":[],"actions":{"block":true}}`, "invalid_body"},
		{"actions_wrong_type", `{"actions":[]}`, "invalid_body"},
		{"malformed_json", `{"actions":`, "invalid_body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := f.businessAndAudit(t)
			data := f.request(t, http.MethodPost, "/admin/policy-advisor/apply", f.adminToken, tc.body, http.StatusBadRequest)
			var failure struct {
				Error struct{ Code string } `json:"error"`
			}
			if err := json.Unmarshal(data, &failure); err != nil || failure.Error.Code != tc.code {
				t.Fatalf("error code = %q err=%v, want %q", failure.Error.Code, err, tc.code)
			}
			if f.businessAndAudit(t) != before {
				t.Fatal("rejected body changed policy/configuration/apply audit")
			}
		})
	}
}

func TestPolicyAdvisorApplyHTTPRequiresAdminWriteNotReadScopes(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, false)
	body := `{"actions":{"block":true}}`
	// Positive control: admin:write alone, no security:read/admin:read requirement
	// at this endpoint. The UI's route/source requirements are separate.
	f.apply(t, body)
	for _, scopes := range [][]string{{"security:read"}, {"admin:read"}, {"security:read", "admin:read"}, {}} {
		t.Run("denied_"+policySimulationScopeLabel(scopes), func(t *testing.T) {
			before := f.businessAndAudit(t)
			token := issueLLMScopedTestToken(t, f.db, f.server, t.Name(), "contract_operator", "", scopes, time.Now().UTC())
			f.request(t, http.MethodPost, "/admin/policy-advisor/apply", token, body, http.StatusUnauthorized)
			if f.businessAndAudit(t) != before {
				t.Fatal("denied caller changed policy/configuration/apply audit")
			}
		})
	}
	before := f.businessAndAudit(t)
	f.request(t, http.MethodPost, "/admin/policy-advisor/apply", "", body, http.StatusUnauthorized)
	if f.businessAndAudit(t) != before {
		t.Fatal("unauthenticated caller changed policy/configuration/apply audit")
	}
	// Authentication/session audit writes are intentionally outside that snapshot.
}

func TestPolicyAdvisorApplyHTTPMayRecordPostChangeDryRun(t *testing.T) {
	f := newPolicyAdvisorApplyHTTPFixture(t, true)
	const seedKey = "redteam.seed_version"
	if _, found, err := f.db.GetAdminSetting(t.Context(), seedKey); err != nil || found {
		t.Fatalf("seed-version setting must be absent before first post-change check: found=%v err=%v", found, err)
	}
	before := f.unchangedConfiguration(t, seedKey)
	id := f.apply(t, `{"title":"post-change control","actions":{"block":true}}`)
	campaigns, err := f.db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatalf("post-change campaigns = %d err=%v", len(campaigns), err)
	}
	c := campaigns[0]
	if c.TriggerAction != "policy_advisor.apply" || c.TriggerRef != id || c.TriggerSource != "post-change" || c.ExecutionMode != "dry-run" || c.ExternalProviderAllowed || c.Status != "completed" {
		t.Fatal("expected existing synchronous post-change dry-run campaign, not a live or disabled hook")
	}
	runs, err := f.db.ListRedTeamRuns(t.Context(), 20)
	if err != nil || len(runs) == 0 {
		t.Fatalf("expected recorded dry-run work, count=%d err=%v", len(runs), err)
	}
	for _, run := range runs {
		if run.CampaignID != c.ID || run.Mode != "dry-run" {
			t.Fatal("unexpected campaign ownership or execution mode")
		}
	}
	seed, found, err := f.db.GetAdminSetting(t.Context(), seedKey)
	if err != nil || !found || seed.ValueJSON != "2" || seed.ValueType != "int" || seed.Source != "system" || seed.Category != "redteam" || seed.Version != 1 || !strings.HasPrefix(seed.UpdatedBy, "admin_") {
		t.Fatalf("expected explicit system seed-version record: found=%v err=%v", found, err)
	}
	history, err := f.db.ListAdminSettingHistory(t.Context(), seedKey, 100)
	if err != nil || len(history) != 1 || history[0].Key != seedKey || history[0].OldValueJSON != "" || history[0].NewValueJSON != "2" || history[0].ChangedBy != seed.UpdatedBy || history[0].Reason != "redteam probe seed rebuild to literal prompts" {
		t.Fatalf("expected one initial seed-version history record: count=%d err=%v", len(history), err)
	}
	if f.policy(t, id).Enabled || f.unchangedConfiguration(t, seedKey) != before {
		t.Fatal("post-change work enabled the draft or changed existing policy/unrelated settings")
	}
	// The fixture's cleanup checks local upstream0. This is not a general billing,
	// all-database-no-write, successful-audit, or production-network guarantee.
}

type policyAdvisorApplyHTTPFixture struct {
	*apiKeyScopeContractFixture
	server *Server
}

func newPolicyAdvisorApplyHTTPFixture(t *testing.T, postChange bool) *policyAdvisorApplyHTTPFixture {
	t.Helper()
	f := &policyAdvisorApplyHTTPFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f.upstreamCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if calls := f.upstreamCalls.Load(); calls != 0 {
			t.Errorf("apply contract unexpectedly reached local upstream %d times", calls)
		}
	})
	// Explicit SQLite helper: TEST_POSTGRES_DSN cannot redirect this fixture.
	f.db = openSQLiteTestStore(t, filepath.Join(t.TempDir(), "policy-apply.db"))
	logger := store.NewAsyncLogger(f.db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	cfg := testConfig(upstream.URL, "public-synthetic-upstream-key")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "public-synthetic-apply-jwt-key", time.Hour
	cfg.RedTeam.PostChangeEnabled, cfg.RedTeam.PostChangeMaxTargets = postChange, 1
	var err error
	f.server, err = NewServer(cfg, f.db, logger, nil)
	if err != nil {
		logger.Stop(context.Background())
		t.Fatal(err)
	}
	f.gateway = httptest.NewServer(f.server.Routes())
	t.Cleanup(func() { f.gateway.Close(); logger.Stop(context.Background()) })
	f.adminToken = issueLLMScopedTestToken(t, f.db, f.server, "apply-writer", "contract_operator", "", []string{"admin:write"}, time.Now().UTC())
	if err := f.db.UpsertPolicyWithRules(t.Context(), store.Policy{ID: "kept-policy", Name: "existing policy", Enabled: true, RolloutPercent: 25}, []store.PolicyRule{{ID: "kept-rule", Enabled: true, Conditions: map[string]any{"model": "unrelated"}, Actions: map[string]any{"block": true}}}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "apply.contract", Category: "contract", ValueJSON: "17", ValueType: "int"}, "synthetic", "existing setting"); err != nil {
		t.Fatal(err)
	}
	if postChange {
		if err := f.db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "local-contract", BaseURL: upstream.URL, Enabled: true, ModelPatterns: "public-local-model"}); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *policyAdvisorApplyHTTPFixture) apply(t *testing.T, body string) string {
	t.Helper()
	data := f.request(t, http.MethodPost, "/admin/policy-advisor/apply", f.adminToken, body, http.StatusCreated)
	var ack struct {
		PolicyID string `json:"policy_id"`
		Enabled  *bool  `json:"enabled"`
		Note     string `json:"note"`
	}
	if err := json.Unmarshal(data, &ack); err != nil || ack.PolicyID == "" || ack.Enabled == nil || *ack.Enabled || ack.Note == "" {
		t.Fatalf("missing/malformed disabled-draft acknowledgement: err=%v", err)
	}
	return ack.PolicyID
}

func (f *policyAdvisorApplyHTTPFixture) policy(t *testing.T, id string) store.Policy {
	t.Helper()
	policies, err := f.db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range policies {
		if p.ID == id {
			return p
		}
	}
	t.Fatal("expected policy missing")
	return store.Policy{}
}

func (f *policyAdvisorApplyHTTPFixture) applyAudits(t *testing.T) []store.AdminAuditPublic {
	t.Helper()
	rows, err := f.db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal(err)
	}
	selected := []store.AdminAuditPublic{}
	for _, row := range rows {
		if row.Action == "policy_advisor.apply" {
			selected = append(selected, row)
		}
	}
	return selected
}

func (f *policyAdvisorApplyHTTPFixture) unchangedConfiguration(t *testing.T, exceptSetting ...string) string {
	t.Helper()
	settings, err := f.db.ListAdminSettings(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, excluded := range exceptSetting {
		filtered := settings[:0]
		for _, setting := range settings {
			if setting.Key != excluded {
				filtered = append(filtered, setting)
			}
		}
		settings = filtered
	}
	history, err := f.db.ListAdminSettingHistory(t.Context(), "apply.contract", 100)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal([]any{f.policy(t, "kept-policy"), settings, history})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func (f *policyAdvisorApplyHTTPFixture) businessAndAudit(t *testing.T) string {
	t.Helper()
	policies, err := f.db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal([]any{policies, f.unchangedConfiguration(t), f.applyAudits(t)})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
