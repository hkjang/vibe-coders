package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These pin existing HTTP/storage behavior, not complete historical replay or
// production-policy enforcement. The shared fixture uses SQLite by default;
// TEST_POSTGRES_DSN opts into its existing isolated-schema PostgreSQL helper.
func TestPolicySimulationHTTPCountsHistoricalCostAndCandidateDenominators(t *testing.T) {
	f := newPolicySimulationHTTPFixture(t)
	f.seedHistory(t)
	before := f.policyConfiguration(t)
	body := `{"window":"7d","rules":[{"name":"blocked model","conditions":{"model":"blocked-model"},"actions":{"block":true}},{"name":"risky review","conditions":{"risk_score":">80"},"actions":{"require_approval":true}}]}`
	got := f.simulate(t, body)
	if got.Evaluated != 4 || got.Blocked != 2 || got.RequireApproval != 1 || got.Allowed != 1 {
		t.Fatalf("counts = %+v, want evaluated 4 / blocked 2 / approval 1 / allowed 1", got)
	}
	if got.BlockRate != .5 || got.Shadow.FalsePositiveCandidates != 1 || got.Shadow.FalsePositiveRate != .5 {
		t.Fatalf("rates: block=%v candidates=%d candidate/blocked=%v", got.BlockRate, got.Shadow.FalsePositiveCandidates, got.Shadow.FalsePositiveRate)
	}
	// This is the recorded estimated cost of blocked rows, not a future saving,
	// a bill, or evidence that cost conditions were reconstructed.
	if got.Shadow.BlockedCostKRW != 20 || got.Shadow.AffectedKeys != 1 || got.Shadow.AffectedTeams != 1 {
		t.Fatalf("blocked-only impact = %+v", got.Shadow)
	}
	if len(got.SampleBlocked) != 2 || len(got.Shadow.FalsePositiveSample) != 1 {
		t.Fatalf("sample lengths = %d / %d", len(got.SampleBlocked), len(got.Shadow.FalsePositiveSample))
	}
	if got.Shadow.FalsePositiveSample[0]["team_id"] != "current-team" {
		t.Fatal("team must reflect the current API-key join, not the former historical team")
	}
	if _, err := time.Parse(time.RFC3339, got.Since); err != nil {
		t.Fatalf("invalid since: %v", err)
	}
	// A positive explicit limit is applied to newest joined rows. This small
	// fixture does not dynamically prove the default 5000-row cap or truncation.
	limited := f.simulate(t, `{"window":"7d","limit":1,"rules":[{"actions":{"block":true}}]}`)
	if limited.Evaluated != 1 || limited.Blocked != 1 || limited.Shadow.BlockedCostKRW != 2 {
		t.Fatalf("latest-row limit = %+v", limited)
	}
	if after := f.policyConfiguration(t); after != before {
		t.Fatal("successful simulation changed policies, settings, or setting history")
	}
}

func TestPolicySimulationHTTPRequiresAdminWriteIndependentlyOfReadScopes(t *testing.T) {
	f := newPolicySimulationHTTPFixture(t)
	body := `{"rules":[{"actions":{"block":true}}],"window":"7d"}`
	before := f.policyConfiguration(t)
	// The success control has admin:write only: neither security:read nor
	// admin:read is an additional server requirement for this POST.
	f.simulate(t, body)
	for _, scopes := range [][]string{{"security:read"}, {"admin:read"}, {"security:read", "admin:read"}, {}} {
		t.Run("denied_"+policySimulationScopeLabel(scopes), func(t *testing.T) {
			token := issueLLMScopedTestToken(t, f.db, f.server, t.Name(), "contract_operator", "", scopes, time.Now().UTC())
			f.request(t, http.MethodPost, "/admin/policies/simulate", token, body, http.StatusUnauthorized)
		})
	}
	if after := f.policyConfiguration(t); after != before {
		t.Fatal("scope checks changed policies, settings, or setting history")
	}
	// Denied authorization may append an auth audit; this is deliberately not
	// an assertion that the whole database is unchanged.
}

func TestPolicySimulationHTTPUnreconstructedConditionsAreNotSafetyEvidence(t *testing.T) {
	f := newPolicySimulationHTTPFixture(t)
	f.seedHistory(t)
	contexts, err := f.db.GovernanceSimContexts(t.Context(), time.Now().UTC().Add(-7*24*time.Hour), 100)
	if err != nil || len(contexts) != 4 {
		t.Fatalf("seeded contexts: count=%d err=%v", len(contexts), err)
	}
	var recordedCost float64
	for _, row := range contexts {
		recordedCost += row.CostKRW
	}
	if recordedCost != 25 {
		t.Fatalf("historical costs were not seeded: %v", recordedCost)
	}
	before := f.policyConfiguration(t)
	for _, tc := range []struct {
		name       string
		conditions map[string]any
		context    governanceContext
		blocked    int
	}{
		{"secret_true_not_reconstructed", map[string]any{"contains_secret": true}, governanceContext{ContainsSecret: true}, 0},
		{"cost_not_copied_to_evaluator", map[string]any{"cost_krw": ">0"}, governanceContext{CostKRW: 12.5}, 0},
		{"mcp_not_reconstructed", map[string]any{"mcp_tool": "public-tool"}, governanceContext{MCPTool: "public-tool"}, 0},
		// Unsupported context isn't uniformly ignored: the default false value
		// matches this negative condition, so zero matches above imply no safety.
		{"secret_false_matches_default", map[string]any{"contains_secret": false}, governanceContext{}, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rule := store.PolicyRule{Conditions: tc.conditions, Actions: map[string]any{"block": true}}
			if !evaluatePolicyRules([]store.PolicyRule{rule}, tc.context).Blocked {
				t.Fatal("positive evaluator control did not block the explicitly supplied context")
			}
			body, err := json.Marshal(map[string]any{"window": "7d", "rules": []store.PolicyRule{rule}})
			if err != nil {
				t.Fatal(err)
			}
			got := f.simulate(t, string(body))
			if got.Evaluated != 4 || got.Blocked != tc.blocked || got.Allowed != 4-tc.blocked || got.RequireApproval != 0 {
				t.Fatalf("limited reconstruction = %+v, want blocked %d", got, tc.blocked)
			}
		})
	}
	if after := f.policyConfiguration(t); after != before {
		t.Fatal("simulation mutated policies or configuration")
	}
}

func TestPolicySimulationHTTPEmptyPopulationHasZeroDenominators(t *testing.T) {
	f := newPolicySimulationHTTPFixture(t)
	got := f.simulate(t, `{"rules":[{"actions":{"block":true}}]}`)
	if got.Evaluated != 0 || got.Blocked != 0 || got.RequireApproval != 0 || got.Allowed != 0 || got.BlockRate != 0 {
		t.Fatalf("empty population counts = %+v", got)
	}
	if got.Shadow.FalsePositiveCandidates != 0 || got.Shadow.FalsePositiveRate != 0 || got.Shadow.BlockedCostKRW != 0 || len(got.SampleBlocked) != 0 || len(got.Shadow.FalsePositiveSample) != 0 {
		t.Fatalf("empty population impact = %+v", got.Shadow)
	}
}

type policySimulationHTTPFixture struct {
	*apiKeyScopeContractFixture
	server *Server
}

func newPolicySimulationHTTPFixture(t *testing.T) *policySimulationHTTPFixture {
	t.Helper()
	f := &policySimulationHTTPFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f.upstreamCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if calls := f.upstreamCalls.Load(); calls != 0 {
			t.Errorf("simulation reached loopback model upstream %d times", calls)
		}
	})
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	f.adminToken = issueLLMScopedTestToken(t, f.db, f.server, "simulation-writer", "contract_operator", "", []string{"admin:write"}, time.Now().UTC())
	if err := f.db.UpsertPolicyWithRules(t.Context(), store.Policy{ID: "kept-policy", Name: "existing policy", Enabled: true, RolloutPercent: 25}, []store.PolicyRule{{ID: "kept-rule", Enabled: true, Conditions: map[string]any{"model": "unrelated"}, Actions: map[string]any{"block": true}}}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "simulation.contract", Category: "contract", ValueJSON: "17", ValueType: "int"}, "synthetic", "existing setting"); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *policySimulationHTTPFixture) seedHistory(t *testing.T) {
	t.Helper()
	when := time.Now().UTC().Add(-time.Hour)
	key := store.APIKeyRecord{ID: "blocked-key", Name: "public key identity", KeyHash: "public-synthetic-hash", Team: "former-team", CreatedAt: when}
	if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal(err)
	}
	for i, row := range []struct {
		id, model, key string
		status, risk   int
		cost           float64
		at             time.Time
	}{
		{"blocked-success", "blocked-model", key.ID, 200, 95, 12.5, when},
		{"blocked-error", "blocked-model", key.ID, 500, 10, 7.5, when.Add(time.Second)},
		{"approval", "other-model", "approval-key", 200, 90, 3, when.Add(2 * time.Second)},
		{"allowed", "other-model", "", 200, 10, 2, when.Add(3 * time.Second)},
		{"outside-window", "blocked-model", key.ID, 200, 95, 1000, when.Add(-40 * 24 * time.Hour)},
	} {
		record := store.LogRecord{
			Request: store.RequestLog{ID: row.id, Endpoint: "/v1/chat/completions", Model: row.model, Provider: "public-provider", APIKeyID: row.key, StatusCode: row.status, Complexity: i + 10, CreatedAt: row.at},
			Usage:   &store.TokenUsage{ID: row.id + "-usage", RequestID: row.id, EstimatedCost: row.cost, Currency: "KRW", CreatedAt: row.at},
			Routing: &store.RoutingDecisionLog{ID: row.id + "-routing", RequestID: row.id, Risk: store.RiskAnalysis{Score: row.risk}, CreatedAt: row.at},
		}
		if err := f.db.InsertLogRecord(t.Context(), record); err != nil {
			t.Fatal(err)
		}
	}
	key.Team = "current-team"
	if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal(err)
	}
}

func (f *policySimulationHTTPFixture) policyConfiguration(t *testing.T) string {
	t.Helper()
	policies, err := f.db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	settings, err := f.db.ListAdminSettings(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	history, err := f.db.ListAdminSettingHistory(t.Context(), "simulation.contract", 100)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal([]any{policies, settings, history})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

type policySimulationHTTPResult struct {
	Evaluated       int              `json:"evaluated"`
	Blocked         int              `json:"blocked"`
	RequireApproval int              `json:"require_approval"`
	Allowed         int              `json:"allowed"`
	BlockRate       float64          `json:"block_rate"`
	Since           string           `json:"since"`
	SampleBlocked   []map[string]any `json:"sample_blocked"`
	Shadow          struct {
		AffectedKeys            int              `json:"affected_keys"`
		AffectedTeams           int              `json:"affected_teams"`
		FalsePositiveCandidates int              `json:"false_positive_candidates"`
		FalsePositiveRate       float64          `json:"false_positive_rate"`
		BlockedCostKRW          float64          `json:"blocked_cost_krw"`
		FalsePositiveSample     []map[string]any `json:"false_positive_sample"`
	} `json:"shadow"`
}

func (f *policySimulationHTTPFixture) simulate(t *testing.T, body string) policySimulationHTTPResult {
	t.Helper()
	data := f.request(t, http.MethodPost, "/admin/policies/simulate", f.adminToken, body, http.StatusOK)
	var result policySimulationHTTPResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	// Check presence as well as values, so omitted fields cannot accidentally
	// satisfy zero-valued controls. This is a handler test, not adapter proof.
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	assertFields := func(object map[string]json.RawMessage, typ reflect.Type) {
		for i := 0; i < typ.NumField(); i++ {
			name := typ.Field(i).Tag.Get("json")
			if raw, ok := object[name]; !ok || string(raw) == "null" {
				t.Fatalf("required response field %q missing or null", name)
			}
		}
	}
	assertFields(object, reflect.TypeOf(result))
	var shadow map[string]json.RawMessage
	if err := json.Unmarshal(object["shadow"], &shadow); err != nil {
		t.Fatal(err)
	}
	assertFields(shadow, reflect.TypeOf(result.Shadow))
	return result
}

func policySimulationScopeLabel(scopes []string) string {
	if len(scopes) == 0 {
		return "no_scopes"
	}
	label := scopes[0]
	for _, scope := range scopes[1:] {
		label += "+" + scope
	}
	return label
}
