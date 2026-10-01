package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Baseline contract tests through real Routes and SQLStore. The normal controls
// describe existing behavior; atomic/rejection/restore cases intentionally expose
// current defects before any implementation. These tests do not promise CAS,
// atomic audit, byte-exact JSON restoration, or whole-database rollback.
// openTestStore selects isolated SQLite by default; PostgreSQL is a separate,
// explicitly authorized opt-in using its existing per-test schema fixture.
func TestPolicyImportContractMultiAndReplay(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	before := f.snapshot(t)
	untouched := f.policy(t, "untouched")
	updated := f.policy(t, "existing")
	updated.Name, updated.Priority = "updated public policy", -7
	updated.Rules[0].Conditions = map[string]any{"model": "public-after", "unknown": map[string]any{"MixedCase": []any{float64(7), true, nil}}}
	created := policyImportContractPolicy("new-first", "new-first-rule")
	empty := policyImportContractPolicy("new-empty", "")
	body := policyImportContractBody(t, updated, created, empty)
	status, data := f.request(t, http.MethodPost, "/admin/policies/import?dry_run=1", body)
	assertPolicyImportPlan(t, status, data, true, 2, 1, 3)
	if f.snapshot(t) != before {
		t.Fatal("successful dry-run changed policies, active rules, or import audit")
	}
	status, data = f.request(t, http.MethodPost, "/admin/policies/import", body)
	assertPolicyImportPlan(t, status, data, false, 2, 1, 3)
	got := f.policy(t, "existing")
	if got.Name != updated.Name || got.Priority != -7 || got.RolloutPercent != updated.RolloutPercent || !got.CreatedAt.Equal(updated.CreatedAt) || len(got.Rules) != 1 || !reflect.DeepEqual(got.Rules[0].Conditions, updated.Rules[0].Conditions) {
		t.Fatal("valid update lost metadata, rule identity, or unknown nested values")
	}
	if len(f.policies(t)) != 4 || len(f.policy(t, "new-empty").Rules) != 0 || !reflect.DeepEqual(f.policy(t, "untouched"), untouched) {
		t.Fatal("valid multi-import must create two policies and preserve the unrelated policy")
	}
	f.assertAuditCounts(t, 1, 2, 1)
	status, data = f.request(t, http.MethodPost, "/admin/policies/import", body)
	assertPolicyImportPlan(t, status, data, false, 0, 3, 3)
	if len(f.policies(t)) != 4 || f.policy(t, "new-first").Rules[0].ID != "new-first-rule" {
		t.Fatal("replay must reuse submitted policy/rule identities, not create new ones")
	}
	// Stable entity IDs do not make the request idempotent: another import audit
	// is written and update timestamps may change. No automatic replay is tested.
	f.assertAuditCounts(t, 2, 0, 3)
}

func TestPolicyImportContractRulesPresence(t *testing.T) {
	for _, tc := range []struct {
		name, suffix string
		wantRules    int
	}{
		{"omitted_preserves", "", 1},
		{"null_preserves", `,"rules":null`, 1},
		{"empty_clears", `,"rules":[]`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPolicyImportContractFixture(t)
			body := []byte(`{"policies":[{"id":"existing","name":"public presence","enabled":true,"priority":19,"rollout_percent":25` + tc.suffix + `}]}`)
			status, data := f.request(t, http.MethodPost, "/admin/policies/import", body)
			assertPolicyImportPlan(t, status, data, false, 0, 1, 1)
			if len(f.policy(t, "existing").Rules) != tc.wantRules {
				t.Fatalf("rules presence contract: got %d rules, want %d", len(f.policy(t, "existing").Rules), tc.wantRules)
			}
		})
	}
}

func TestPolicyImportContractInvalidTailAtomic(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	before := f.snapshot(t)
	first := f.policy(t, "existing")
	first.Name = "must not partially persist"
	invalid := policyImportContractPolicy("invalid-tail", "invalid-tail-rule")
	invalid.Name = " \t "
	body := policyImportContractBody(t, first, invalid)
	status, _ := f.request(t, http.MethodPost, "/admin/policies/import?dry_run=1", body)
	if status != http.StatusBadRequest || f.snapshot(t) != before {
		t.Fatal("invalid-tail dry-run control must reject without changing policies or import audit")
	}
	status, _ = f.request(t, http.MethodPost, "/admin/policies/import", body)
	if status != http.StatusBadRequest {
		t.Errorf("invalid-tail apply status = %d; want 400", status)
	}
	if f.snapshot(t) != before {
		t.Fatal("atomicity defect: rejected later policy left earlier policy/rules/cache changed")
	}
}

func TestPolicyImportContractRuleCollisionAtomic(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	before := f.snapshot(t)
	first := f.policy(t, "existing")
	first.Name = "must roll back on later store failure"
	collision := policyImportContractPolicy("collision-tail", "untouched-rule")
	status, _ := f.request(t, http.MethodPost, "/admin/policies/import", policyImportContractBody(t, first, collision))
	if status < 400 || status > 599 {
		t.Errorf("global rule ID collision unexpectedly acknowledged: HTTP %d", status)
	}
	if f.snapshot(t) != before {
		t.Fatal("atomicity defect: later global rule collision left earlier policy/rules/cache changed")
	}
}

func TestPolicyImportContractRejectInvalidIDs(t *testing.T) {
	for _, name := range []string{"foreign_parent", "duplicate_policy", "duplicate_rule"} {
		t.Run(name, func(t *testing.T) {
			f := newPolicyImportContractFixture(t)
			before := f.snapshot(t)
			p := policyImportContractPolicy("new-target", "new-target-rule")
			policies := []store.Policy{p}
			switch name {
			case "foreign_parent":
				policies[0].Rules[0].PolicyID = "untouched"
			case "duplicate_policy":
				p.Rules = nil
				policies[0].Rules = nil
				p.Name = "second same identity"
				policies = append(policies, p)
			case "duplicate_rule":
				policies[0].Rules = append(policies[0].Rules, policies[0].Rules[0])
			}
			body := policyImportContractBody(t, policies...)
			// Observe both calls even when dry-run incorrectly accepts. Neither
			// assertion relies on the desired future error code or response shape.
			for _, suffix := range []string{"?dry_run=1", ""} {
				status, _ := f.request(t, http.MethodPost, "/admin/policies/import"+suffix, body)
				if status < 400 || status >= 500 {
					t.Errorf("invalid identity %s%s must be rejected before storage; HTTP %d", name, suffix, status)
				}
				if f.snapshot(t) != before {
					t.Errorf("invalid identity %s%s changed policies, rules, or import audit", name, suffix)
				}
			}
		})
	}
}

func TestPolicyImportContractExportRestoresEmpty(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	empty := policyImportContractPolicy("empty-backup", "")
	if err := f.db.UpsertPolicyWithRules(t.Context(), empty, []store.PolicyRule{}); err != nil {
		t.Fatal(err)
	}
	status, backup := f.request(t, http.MethodGet, "/admin/policies/export", nil)
	if status != http.StatusOK {
		t.Fatalf("export control status = %d", status)
	}
	var exported struct {
		Version  int            `json:"version"`
		Count    int            `json:"count"`
		Policies []store.Policy `json:"policies"`
	}
	if err := json.Unmarshal(backup, &exported); err != nil || exported.Version != 1 || exported.Count != 3 || len(exported.Policies) != 3 {
		t.Fatal("export must identify three policies in the version 1 document")
	}
	changed := policyImportContractPolicy("empty-backup", "later-rule")
	if err := f.db.UpsertPolicyWithRules(t.Context(), changed, changed.Rules); err != nil {
		t.Fatal(err)
	}
	if len(f.policy(t, "empty-backup").Rules) != 1 {
		t.Fatal("positive setup must persist a rule after the zero-rule backup")
	}
	// Replay the actual HTTP export bytes, not a test-normalized rules array.
	status, data := f.request(t, http.MethodPost, "/admin/policies/import", backup)
	assertPolicyImportPlan(t, status, data, false, 0, 3, 3)
	if len(f.policy(t, "empty-backup").Rules) != 0 {
		t.Fatal("restore defect: importing an actual zero-rule backup retained a later rule")
	}
}

type policyImportContractFixture struct {
	db      *store.SQLStore
	gateway *httptest.Server
}

func newPolicyImportContractFixture(t *testing.T) *policyImportContractFixture {
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
			t.Errorf("unexpected loopback upstream calls: %d", calls.Load())
		}
	})
	logger := store.NewAsyncLogger(f.db, 32, filepath.Join(t.TempDir(), "import-fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstream.URL, "public-synthetic-import-upstream")
	cfg.Auth.AdminToken = "public-synthetic-import-admin"
	cfg.RedTeam.PostChangeEnabled = false
	server, err := NewServer(cfg, f.db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.gateway = httptest.NewServer(server.Routes())
	t.Cleanup(f.gateway.Close)
	for _, p := range []store.Policy{policyImportContractPolicy("existing", "existing-rule"), policyImportContractPolicy("untouched", "untouched-rule")} {
		if err := f.db.UpsertPolicyWithRules(t.Context(), p, p.Rules); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func policyImportContractPolicy(id, ruleID string) store.Policy {
	p := store.Policy{ID: id, Name: "public " + id, Description: "public contract", Enabled: true, Priority: 19, RolloutPercent: 25, CreatedAt: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)}
	if ruleID != "" {
		p.Rules = []store.PolicyRule{{ID: ruleID, PolicyID: id, Name: "public rule", Enabled: true, Priority: 10, Conditions: map[string]any{"model": "public-model"}, Actions: map[string]any{"block": true}}}
	}
	return p
}

func policyImportContractBody(t *testing.T, policies ...store.Policy) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"policies": policies})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func (f *policyImportContractFixture) request(t *testing.T, method, path string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer public-synthetic-import-admin")
	req.Header.Set("Content-Type", "application/json")
	response, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, data
}

func (f *policyImportContractFixture) policies(t *testing.T) []store.Policy {
	t.Helper()
	policies, err := f.db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(policies, func(i, j int) bool { return policies[i].ID < policies[j].ID })
	return policies
}

func (f *policyImportContractFixture) policy(t *testing.T, id string) store.Policy {
	t.Helper()
	for _, p := range f.policies(t) {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("synthetic policy %q not found", id)
	return store.Policy{}
}

func (f *policyImportContractFixture) audits(t *testing.T) []store.AdminAuditPublic {
	t.Helper()
	rows, err := f.db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal(err)
	}
	var selected []store.AdminAuditPublic
	for _, row := range rows {
		if row.Action == "governance.policy.import" {
			selected = append(selected, row)
		}
	}
	return selected
}

func (f *policyImportContractFixture) snapshot(t *testing.T) string {
	t.Helper()
	active, err := f.db.ActivePolicyRules(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	data, err := json.Marshal([]any{f.policies(t), active, f.audits(t)})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func (f *policyImportContractFixture) assertAuditCounts(t *testing.T, count, created, updated int) {
	t.Helper()
	rows := f.audits(t)
	if len(rows) != count {
		t.Fatalf("import audits = %d, want %d", len(rows), count)
	}
	wanted := map[string]int{"created": created, "updated": updated}
	for _, row := range rows {
		var after map[string]int
		if err := json.Unmarshal([]byte(row.AfterValue), &after); err != nil {
			t.Fatal(err)
		}
		if reflect.DeepEqual(after, wanted) && row.BeforeValue == "" && row.AdminID != "" {
			return
		}
	}
	t.Fatal("expected successful import count summary and server actor missing")
}

func assertPolicyImportPlan(t *testing.T, status int, data []byte, dryRun bool, created, updated, plans int) {
	t.Helper()
	var result struct {
		DryRun  bool              `json:"dry_run"`
		Created int               `json:"created"`
		Updated int               `json:"updated"`
		Plan    []json.RawMessage `json:"plan"`
	}
	if err := json.Unmarshal(data, &result); status != http.StatusOK || err != nil || result.DryRun != dryRun || result.Created != created || result.Updated != updated || len(result.Plan) != plans {
		t.Fatalf("plan control: HTTP %d, JSON error=%v, dry_run=%v, created=%d, updated=%d, plan=%d", status, err, result.DryRun, result.Created, result.Updated, len(result.Plan))
	}
}
