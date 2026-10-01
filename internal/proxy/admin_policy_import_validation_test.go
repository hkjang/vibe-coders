package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestPolicyImportJSONBoundaries(t *testing.T) {
	const valid = `{"policies":[{"id":"bounded","name":"public bounded","rules":[]}]}`
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"one_document", valid + " \n\t", 200},
		{"second_document", valid + `{}`, 400},
		{"trailing_bytes", valid + "public-secret-marker", 400},
		{"duplicate_root", `{"policies":[],"policies":[]}`, 400},
		{"duplicate_nested", `{"policies":[],"unknown":{"a":1,"\u0061":2}}`, 400},
		{"depth64", valid[:len(valid)-1] + `,"unknown":` + strings.Repeat("[", 63) + "0" + strings.Repeat("]", 63) + "}", 200},
		{"depth65", valid[:len(valid)-1] + `,"unknown":` + strings.Repeat("[", 64) + "0" + strings.Repeat("]", 64) + "}", 400},
		{"invalid_utf8", valid + string([]byte{0xff}), 400},
		{"fractional_priority", `{"policies":[{"id":"p","name":"n","priority":1.5}]}`, 400},
		{"unknown_ignored", valid[:len(valid)-1] + `,"future":{"public":true}}`, 200},
		{"typed_case_alias", `{"Policies":[{"ID":"first","id":"alias","Name":"public","Rules":[]}]}`, 200},
		{"empty_rule_id", `{"policies":[{"id":"p","name":"n","rules":[{"id":"","actions":{"block":true}}]}]}`, 400},
		{"exact_body_limit", valid + strings.Repeat(" ", policyImportMaxBody-len(valid)), 200},
		{"over_body_limit", valid + strings.Repeat(" ", policyImportMaxBody-len(valid)+1), 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPolicyImportContractFixture(t)
			before := f.snapshot(t)
			status, data := f.request(t, http.MethodPost, "/admin/policies/import?dry_run=1", []byte(tc.body))
			if status != tc.status {
				t.Fatalf("status=%d, want %d", status, tc.status)
			}
			if f.snapshot(t) != before {
				t.Fatal("JSON boundary dry-run mutated policy/import audit")
			}
			if status >= 400 && bytes.Contains(data, []byte("public-secret-marker")) {
				t.Fatal("parse response echoed request content")
			}
		})
	}
}

func TestPolicyImportCountBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name            string
		policies, rules int
		status          int
	}{
		{"max_policies", 1000, 0, 200},
		{"too_many_policies", 1001, 0, 400},
		{"max_rules", 1, 10000, 200},
		{"too_many_rules", 1, 10001, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPolicyImportContractFixture(t)
			before := f.snapshot(t)
			policies := make([]store.Policy, tc.policies)
			for i := range policies {
				policies[i] = store.Policy{ID: fmt.Sprintf("p%d", i), Name: "public", Rules: []store.PolicyRule{}}
			}
			for i := 0; i < tc.rules; i++ {
				policies[0].Rules = append(policies[0].Rules, store.PolicyRule{ID: fmt.Sprintf("r%d", i), Actions: map[string]any{"block": true}})
			}
			body := policyImportContractBody(t, policies...)
			if len(body) > policyImportMaxBody {
				t.Fatal("count test must not instead hit byte limit")
			}
			status, _ := f.request(t, http.MethodPost, "/admin/policies/import?dry_run=1", body)
			if status != tc.status || f.snapshot(t) != before {
				t.Fatalf("count boundary status=%d, want %d; dry-run must not write", status, tc.status)
			}
		})
	}
}

func TestPolicyImportNumberTokens(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	const body = `{"policies":[{"id":"numbers","name":"public numbers","rules":[{"id":"number-rule","conditions":{"unknown":{"integer":9007199254740993,"decimal":0.10000000000000001,"finite":1e300}},"actions":{"block":true}}]}]}`
	status, data := f.request(t, http.MethodPost, "/admin/policies/import", []byte(body))
	assertPolicyImportPlan(t, status, data, false, 1, 0, 1)
	status, data = f.request(t, http.MethodGet, "/admin/policies/export", nil)
	if status != http.StatusOK {
		t.Fatalf("number export status=%d", status)
	}
	for _, token := range []string{`9007199254740993`, `0.10000000000000001`, `1e300`} {
		if !bytes.Contains(data, []byte(token)) {
			t.Fatalf("export lost finite number token %s", token)
		}
	}
	for _, bad := range []string{"1e10000", "-1e10000"} {
		before := f.snapshot(t)
		invalid := strings.Replace(body, "1e300", bad, 1)
		for _, suffix := range []string{"?dry_run=1", ""} {
			status, _ := f.request(t, http.MethodPost, "/admin/policies/import"+suffix, []byte(invalid))
			if status != 400 || f.snapshot(t) != before {
				t.Fatal("float64 overflow must retain old rejection before any write")
			}
		}
	}
}

func TestPolicyImportRuleMoves(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("reverse_%v", reverse), func(t *testing.T) {
			f := newPolicyImportContractFixture(t)
			source, target := f.policy(t, "existing"), f.policy(t, "untouched")
			moved := source.Rules[0]
			moved.PolicyID = target.ID
			source.Rules = []store.PolicyRule{}
			target.Rules = append(target.Rules, moved)
			policies := []store.Policy{source, target}
			if reverse {
				policies[0], policies[1] = policies[1], policies[0]
			}
			before := f.snapshot(t)
			// 일반 Policy의 omitempty가 []를 누락시키지 않도록 실제 교체 요청을 명시한다.
			explicit := make([]store.PolicyExport, 0, len(policies))
			for _, policy := range policies {
				explicit = append(explicit, store.PolicyExport{Policy: policy, Rules: policy.Rules})
			}
			body, err := json.Marshal(map[string]any{"policies": explicit})
			if err != nil {
				t.Fatal(err)
			}
			status, data := f.request(t, http.MethodPost, "/admin/policies/import?dry_run=1", body)
			assertPolicyImportPlan(t, status, data, true, 0, 2, 2)
			if f.snapshot(t) != before {
				t.Fatal("move dry-run wrote data")
			}
			status, data = f.request(t, http.MethodPost, "/admin/policies/import", body)
			assertPolicyImportPlan(t, status, data, false, 0, 2, 2)
			if len(f.policy(t, source.ID).Rules) != 0 || len(f.policy(t, target.ID).Rules) != 2 {
				t.Fatal("rule move depends on input order")
			}
		})
	}
	t.Run("nil_source_cannot_release", func(t *testing.T) {
		f := newPolicyImportContractFixture(t)
		before := f.snapshot(t)
		source, target := f.policy(t, "existing"), f.policy(t, "untouched")
		moved := source.Rules[0]
		moved.PolicyID, source.Rules = target.ID, nil
		target.Rules = append(target.Rules, moved)
		status, _ := f.request(t, http.MethodPost, "/admin/policies/import", policyImportContractBody(t, source, target))
		if status != 400 || f.snapshot(t) != before {
			t.Fatal("nil rules must preserve source ownership, not permit theft")
		}
	})
}

func TestPolicyImportExplicitExportAndDefaults(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	body := []byte(`{"policies":[{"id":" \u0085opaque ","name":" \ufeffname ","priority":0,"rollout_percent":250,"rules":[{"id":"opaque-rule","priority":0,"conditions":{" MODEL ":"public"},"actions":{" BLOCK ":true}}]},{"id":"no-rules","name":"public","rules":[]}]}`)
	status, data := f.request(t, http.MethodPost, "/admin/policies/import", body)
	assertPolicyImportPlan(t, status, data, false, 2, 0, 2)
	p := f.policy(t, " \u0085opaque ")
	if p.Name != " \ufeffname " || p.Enabled || p.Priority != 100 || p.RolloutPercent != 100 || p.Rules[0].Priority != 100 || p.Rules[0].PolicyID != p.ID || p.Rules[0].Conditions[" MODEL "] != "public" || p.Rules[0].Actions[" BLOCK "] != true {
		t.Fatal("typed import must not adopt the single-policy decoder's trimming/key/default semantics")
	}
	status, data = f.request(t, http.MethodGet, "/admin/policies/export", nil)
	if status != 200 {
		t.Fatalf("export status=%d", status)
	}
	var exported struct{ Policies []map[string]json.RawMessage }
	if err := json.Unmarshal(data, &exported); err != nil {
		t.Fatal(err)
	}
	for _, policy := range exported.Policies {
		if _, ok := policy["rules"]; !ok {
			t.Fatal("export must explicitly include rules even when empty")
		}
	}
}
