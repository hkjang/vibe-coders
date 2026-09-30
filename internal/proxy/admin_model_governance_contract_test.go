package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These exercise existing Routes/auth/storage contracts, not a new validation
// or model-execution policy. openTestStore uses isolated SQLite by default and
// TEST_POSTGRES_DSN opts into the existing per-test PostgreSQL schema helper.
func TestModelGovernanceContractIdentityDefaultsAndExactDelete(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	first := f.saveContract(t, f.adminToken, `{"name":" Original ","task_type":" code ","min_quality_score":80,"min_golden_pass_rate":0.9,"min_success_rate":0.95,"max_latency_ms":2500,"max_avg_cost_krw":1.25}`)
	before := f.contract(t, first)
	if before.Name != "Original" || before.TaskType != "code" || !before.Enabled || before.CreatedBy != "admin_"+hashProxyKey(f.adminToken)[:12] {
		t.Fatal("contract create must trim labels, default enabled and preserve the existing hashed actor")
	}
	assertModelGovernanceTimestamp(t, before.CreatedAt)
	assertModelGovernanceTimestamp(t, before.UpdatedAt)

	body, err := json.Marshal(map[string]any{
		"id": " \t" + first + "\n", "name": " Revised ", "task_type": nil,
		"min_quality_score": nil, "min_golden_pass_rate": nil, "min_success_rate": nil,
		"max_latency_ms": nil, "max_avg_cost_krw": nil, "enabled": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.saveContract(t, f.otherWriter, string(body)); got != first {
		t.Fatal("same trimmed ID must update rather than insert")
	}
	after := f.contract(t, first)
	if after.Name != "Revised" || after.TaskType != "" || after.Enabled || after.MinQualityScore != 0 ||
		after.MinGoldenPassRate != 0 || after.MinSuccessRate != 0 || after.MaxLatencyMS != 0 || after.MaxAvgCostKRW != 0 {
		t.Fatal("null thresholds/task type must clear to zero/empty and explicit false must stay false")
	}
	if after.CreatedAt != before.CreatedAt || after.CreatedBy != before.CreatedBy {
		t.Fatal("updating with a different admin must not replace creation metadata")
	}
	if rows := f.contracts(t); len(rows) != 1 || len(f.listContracts(t, true)) != 0 {
		t.Fatal("same-ID update must retain one disabled row and enabled-only listing must exclude it")
	}
	f.saveContract(t, f.otherWriter, `{"id":"`+first+`","name":"Revised","enabled":null}`)
	after = f.contract(t, first)
	if !after.Enabled || after.CreatedAt != before.CreatedAt || after.CreatedBy != before.CreatedBy {
		t.Fatal("null enabled retains the legacy true default without changing creation metadata")
	}
	second := f.saveContract(t, f.adminToken, `{"name":"Revised"}`)
	if second == first || len(f.contracts(t)) != 2 {
		t.Fatal("omitting ID must create a distinct contract even when its name is identical")
	}
	if got := f.listContracts(t, false); !reflect.DeepEqual(got, f.contracts(t)) {
		t.Fatal("HTTP list and persisted contracts differ")
	}
	f.request(t, http.MethodDelete, "/admin/models/contracts?id="+url.QueryEscape(first), f.adminToken, "", http.StatusOK)
	if _, found, err := f.db.GetModelContract(t.Context(), first); err != nil || found {
		t.Fatal("exact contract DELETE did not remove its target")
	}
	if got := f.contracts(t); len(got) != 1 || got[0].ID != second {
		t.Fatal("contract DELETE changed a same-name neighbor")
	}
	events := f.audits(t)
	if len(events) != 5 {
		t.Fatal("four upserts and one delete must retain their existing admin audits")
	}
	for _, event := range events {
		if event.Action == "model_contract_delete" {
			if event.BeforeValue != first || event.AfterValue != "" {
				t.Fatal("contract deletion audit must identify only the exact target")
			}
			continue
		}
		var payload map[string]any
		if event.Action != "model_contract_upsert" || event.BeforeValue != "" || json.Unmarshal([]byte(event.AfterValue), &payload) != nil || len(payload) != 3 || payload["id"] == "" {
			t.Fatal("contract upsert audit must retain its id/name/task_type summary")
		}
	}
}

func TestModelGovernanceContractDeprecationPatternNullsAndExactDelete(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	first := f.saveDeprecation(t, `{"model_glob":" \tGPT-LEGACY-*\u0085 ","replacement":" next-model ","sunset_date":" 2030-01-02 ","message":" public notice "}`)
	if first.ID == "" || first.ModelGlob != "GPT-LEGACY-*" || first.Replacement != "next-model" || first.SunsetDate != "2030-01-02" || first.Message != "public notice" {
		t.Fatal("deprecation create must retain existing TrimSpace normalization")
	}
	assertModelGovernanceTimestamp(t, first.CreatedAt)
	second := f.saveDeprecation(t, `{"model_glob":" gpt-legacy-* ","replacement":null,"sunset_date":null,"message":null}`)
	if second.ID != first.ID || second.CreatedAt != first.CreatedAt || second.ModelGlob != "gpt-legacy-*" || second.Replacement != "" || second.SunsetDate != "" || second.Message != "" {
		t.Fatal("case-insensitive trimmed pattern upsert must return 201, preserve creation time and clear null optional fields")
	}
	assertModelGovernanceTimestamp(t, second.UpdatedAt)
	third := f.saveDeprecation(t, `{"id":"`+first.ID+`","model_glob":"gpt-different-*"}`)
	if third.ID == first.ID || len(f.deprecations(t)) != 2 {
		t.Fatal("a different pattern must append even when an ignored legacy id field is supplied")
	}
	before, audits := f.deprecations(t), f.audits(t)
	for _, date := range []string{"2030-02-30", "2030-1-02", "2030-01-02T00:00:00Z"} {
		f.request(t, http.MethodPost, "/admin/model-deprecations", f.adminToken,
			`{"model_glob":"gpt-legacy-*","sunset_date":"`+date+`"}`, http.StatusBadRequest)
	}
	if !reflect.DeepEqual(before, f.deprecations(t)) || !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("invalid dates must not mutate stored rows or add successful admin audits")
	}
	var listed struct {
		Deprecations []store.ModelDeprecation `json:"deprecations"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, "/admin/model-deprecations", f.reader, "", http.StatusOK), &listed) != nil || !reflect.DeepEqual(listed.Deprecations, before) {
		t.Fatal("deprecation HTTP list must match committed storage")
	}
	f.request(t, http.MethodDelete, "/admin/model-deprecations/"+url.PathEscape(first.ID), f.adminToken, "", http.StatusOK)
	if got := f.deprecations(t); len(got) != 1 || got[0].ID != third.ID {
		t.Fatal("deprecation DELETE must remove only the exact pattern-derived ID")
	}
	if events := f.audits(t); len(events) != 4 {
		t.Fatal("three accepted 201 upserts and one deletion must retain their admin audits")
	} else {
		for _, event := range events {
			if event.Action == "model_deprecation.delete" {
				if event.BeforeValue != first.ID || event.AfterValue != "" {
					t.Fatal("deprecation delete audit target changed")
				}
			} else if event.Action != "model_deprecation.upsert" || event.BeforeValue == "" {
				t.Fatal("unexpected deprecation audit action/target")
			}
		}
	}
}

func TestModelGovernanceContractRunIsReadOnlyDatabaseEvaluation(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	id := f.saveContract(t, f.adminToken, `{"name":"Observed thresholds","min_quality_score":80,"min_golden_pass_rate":0.9,"min_success_rate":0.95,"max_latency_ms":2500,"max_avg_cost_krw":2}`)
	disabled := f.saveContract(t, f.adminToken, `{"name":"Disabled but explicitly selectable","enabled":false}`)
	before, audits := f.contracts(t), f.audits(t)
	for _, contractID := range []string{"", id, disabled} {
		payload, err := json.Marshal(map[string]string{"model": " public-model ", "contract_id": contractID, "window": "30d"})
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Model       string          `json:"model"`
			HaveMetrics map[string]bool `json:"have_metrics"`
			Replaceable bool            `json:"replaceable"`
			Results     []struct {
				ID      string `json:"contract_id"`
				Verdict string `json:"verdict"`
				Checks  []struct {
					Status string   `json:"status"`
					Actual *float64 `json:"actual"`
				} `json:"checks"`
			} `json:"results"`
			FailingSamples []json.RawMessage `json:"failing_samples"`
		}
		data := f.request(t, http.MethodPost, "/admin/models/contracts/run", f.adminToken, string(payload), http.StatusOK)
		if json.Unmarshal(data, &got) != nil || got.Model != "public-model" || got.Replaceable || len(got.Results) != 1 || got.Results[0].Verdict != "no_data" || len(got.FailingSamples) != 0 {
			t.Fatal("run must calculate observed no-data results without manufacturing safe adoption")
		}
		wantID, checks := id, 5
		if contractID == disabled {
			wantID, checks = disabled, 0
		}
		if got.Results[0].ID != wantID || len(got.Results[0].Checks) != checks || len(got.HaveMetrics) != 3 {
			t.Fatal("default run must use enabled contracts, explicit ID may select disabled contracts")
		}
		for _, have := range got.HaveMetrics {
			if have {
				t.Fatal("empty observation database unexpectedly reports metrics")
			}
		}
		for _, check := range got.Results[0].Checks {
			if check.Status != "no_data" || check.Actual != nil {
				t.Fatal("absent metric must remain no_data with null actual")
			}
		}
	}
	f.request(t, http.MethodPost, "/admin/models/contracts/run", f.adminToken, `{"model":"public-model","contract_id":"missing-contract"}`, http.StatusNotFound)
	f.request(t, http.MethodPost, "/admin/models/contracts/run", f.adminToken, `{"model":" "}`, http.StatusBadRequest)
	if !reflect.DeepEqual(before, f.contracts(t)) || !reflect.DeepEqual(audits, f.audits(t)) || len(f.deprecations(t)) != 0 {
		t.Fatal("pure database run must not save contracts/deprecations or emit mutation audits")
	}
}

func TestModelGovernanceContractAuthorizationRetainsExistingScopes(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	id := f.saveContract(t, f.adminToken, `{"name":"protected"}`)
	dep := f.saveDeprecation(t, `{"model_glob":"protected-*"}`)
	before, deprecations, audits := f.contracts(t), f.deprecations(t), f.audits(t)
	for _, token := range []string{"", f.scopeless} {
		f.request(t, http.MethodGet, "/admin/models/contracts", token, "", http.StatusUnauthorized)
		f.request(t, http.MethodGet, "/admin/model-deprecations", token, "", http.StatusUnauthorized)
	}
	for _, token := range []string{"", f.scopeless, f.reader} {
		for _, request := range []struct{ method, path, body string }{
			{http.MethodPost, "/admin/models/contracts", `{"id":"` + id + `","name":"denied"}`},
			{http.MethodDelete, "/admin/models/contracts?id=" + url.QueryEscape(id), ""},
			{http.MethodPost, "/admin/models/contracts/run", `{"model":"public-model"}`},
			{http.MethodPost, "/admin/model-deprecations", `{"model_glob":"protected-*","message":"denied"}`},
			{http.MethodDelete, "/admin/model-deprecations/" + url.PathEscape(dep.ID), ""},
		} {
			f.request(t, request.method, request.path, token, request.body, http.StatusUnauthorized)
		}
	}
	if !reflect.DeepEqual(before, f.contracts(t)) || !reflect.DeepEqual(deprecations, f.deprecations(t)) || !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("denied operations must not alter governance rows or successful mutation audits")
	}
}

func TestModelGovernanceContractRunUsesStoredGoldenWithoutRawResponse(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	id := f.saveContract(t, f.adminToken, `{"name":"Golden minimum","min_golden_pass_rate":0.9}`)
	const promptID, rawResponse = "synthetic-private-prompt-identity", "synthetic-private-model-response"
	if err := f.db.InsertGoldenPromptResult(t.Context(), store.GoldenPromptResult{
		ID: "governance-observed-golden", PromptID: promptID, Model: "observed-model",
		Score: 0.25, Passed: false, Response: rawResponse, CreatedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	before, err := f.db.ListGoldenPromptResults(t.Context(), promptID, 10)
	if err != nil {
		t.Fatal(err)
	}
	contracts, audits := f.contracts(t), f.audits(t)
	data := f.request(t, http.MethodPost, "/admin/models/contracts/run", f.adminToken,
		`{"model":"observed-model","contract_id":"`+id+`","window":"30d"}`, http.StatusOK)
	var got struct {
		Replaceable bool `json:"replaceable"`
		Results     []struct {
			Verdict string `json:"verdict"`
			Checks  []struct {
				Status    string  `json:"status"`
				Actual    float64 `json:"actual"`
				Dimension string  `json:"dimension"`
			} `json:"checks"`
		} `json:"results"`
		Samples []struct {
			Fingerprint string `json:"fingerprint"`
			Reason      string `json:"reason"`
		} `json:"failing_samples"`
	}
	if json.Unmarshal(data, &got) != nil || got.Replaceable || len(got.Results) != 1 || got.Results[0].Verdict != "fail" || len(got.Results[0].Checks) != 1 {
		t.Fatal("stored failed Golden result must fail the configured pass-rate threshold")
	}
	check := got.Results[0].Checks[0]
	if check.Dimension != "golden_pass_rate" || check.Status != "fail" || check.Actual != 0 || len(got.Samples) != 1 || len(got.Samples[0].Fingerprint) != 12 || got.Samples[0].Reason == "" {
		t.Fatal("run must derive the failed pass rate and bounded fingerprint from stored observations")
	}
	if strings.Contains(string(data), promptID) || strings.Contains(string(data), rawResponse) {
		t.Fatal("contract evaluation must not return raw Golden identity or model response")
	}
	after, err := f.db.ListGoldenPromptResults(t.Context(), promptID, 10)
	if err != nil || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(contracts, f.contracts(t)) || !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("evaluation must not append/replace observations, contracts or mutation audits")
	}
}

type modelGovernanceContractFixture struct {
	*apiKeyScopeContractFixture
	otherWriter, reader, scopeless string
}

func newModelGovernanceContractFixture(t *testing.T) *modelGovernanceContractFixture {
	t.Helper()
	base := &apiKeyScopeContractFixture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		base.upstreamCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if base.upstreamCalls.Load() != 0 {
			t.Error("governance CRUD and contracts/run must not execute upstream model requests")
		}
	})
	var server *Server
	base.gateway, server, base.db = scopedSettingsSecurityServer(t, upstream.URL)
	if !server.cfg.Auth.Enabled {
		t.Fatal("governance contract requires actual enabled authentication")
	}
	now := time.Now().UTC()
	base.adminToken = issueLLMScopedTestToken(t, base.db, server, "governance-writer", "model_operator", "", []string{"admin:read", "admin:write"}, now)
	return &modelGovernanceContractFixture{
		apiKeyScopeContractFixture: base,
		otherWriter:                issueLLMScopedTestToken(t, base.db, server, "governance-other", "model_operator", "", []string{"admin:read", "admin:write"}, now),
		reader:                     issueLLMScopedTestToken(t, base.db, server, "governance-reader", "readonly_admin", "", []string{"admin:read"}, now),
		scopeless:                  issueLLMScopedTestToken(t, base.db, server, "governance-scopeless", "developer", "", []string{}, now),
	}
}

func (f *modelGovernanceContractFixture) saveContract(t *testing.T, token, body string) string {
	t.Helper()
	var got struct {
		ID string `json:"id"`
		OK bool   `json:"ok"`
	}
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/models/contracts", token, body, http.StatusOK), &got) != nil || !got.OK || !strings.HasPrefix(got.ID, "mcon_") {
		t.Fatal("contract POST must return its generated/stored ID and ok at 200")
	}
	return got.ID
}

func (f *modelGovernanceContractFixture) contract(t *testing.T, id string) store.ModelContract {
	t.Helper()
	got, found, err := f.db.GetModelContract(t.Context(), id)
	if err != nil || !found {
		t.Fatal("committed contract lookup failed")
	}
	return got
}

func (f *modelGovernanceContractFixture) contracts(t *testing.T) []store.ModelContract {
	t.Helper()
	got, err := f.db.ListModelContracts(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func (f *modelGovernanceContractFixture) listContracts(t *testing.T, enabled bool) []store.ModelContract {
	t.Helper()
	path := "/admin/models/contracts"
	if enabled {
		path += "?enabled=1"
	}
	var got struct {
		Contracts []store.ModelContract `json:"contracts"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, path, f.reader, "", http.StatusOK), &got) != nil || got.Contracts == nil {
		t.Fatal("contract GET must return a concrete list")
	}
	return got.Contracts
}

func (f *modelGovernanceContractFixture) saveDeprecation(t *testing.T, body string) store.ModelDeprecation {
	t.Helper()
	var got struct {
		Deprecation store.ModelDeprecation `json:"deprecation"`
	}
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/model-deprecations", f.adminToken, body, http.StatusCreated), &got) != nil || got.Deprecation.ID == "" {
		t.Fatal("deprecation create and update must return the saved row at 201")
	}
	rows := f.deprecations(t)
	for _, row := range rows {
		if row.ID == got.Deprecation.ID {
			if row != got.Deprecation {
				t.Fatal("deprecation returned row differs from committed storage")
			}
			return got.Deprecation
		}
	}
	t.Fatal("deprecation POST did not persist its returned ID")
	return store.ModelDeprecation{}
}

func (f *modelGovernanceContractFixture) deprecations(t *testing.T) []store.ModelDeprecation {
	t.Helper()
	got, err := f.db.ListModelDeprecations(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func (f *modelGovernanceContractFixture) audits(t *testing.T) []store.AdminAuditPublic {
	t.Helper()
	got, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func assertModelGovernanceTimestamp(t *testing.T, value string) {
	t.Helper()
	if stamp, err := time.Parse(time.RFC3339Nano, value); err != nil || stamp.IsZero() {
		t.Fatal("persisted timestamp must be valid and nonzero, without a wall-clock ordering assumption")
	}
}
