package store

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestPolicyImportRollbackAndCache(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	policies := []Policy{
		{ID: "import-a", Name: "old-a", Enabled: true, Rules: []PolicyRule{{ID: "rule-a", Enabled: true, Conditions: map[string]any{"model": "old-a"}}}},
		{ID: "import-b", Name: "old-b", Enabled: true, Rules: []PolicyRule{{ID: "rule-b", Enabled: true, Conditions: map[string]any{"model": "old-b"}}}},
	}
	for _, p := range policies {
		if err := db.UpsertPolicyWithRules(t.Context(), p, p.Rules); err != nil {
			t.Fatal(err)
		}
	}
	before, err := db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	warm, err := db.ActivePolicyRules(t.Context())
	if err != nil || len(warm) != 2 {
		t.Fatalf("warm active-rule control: count=%d error=%v", len(warm), err)
	}
	gen := db.policies.beginLoad()
	policies[0].Name = "changed-a"
	policies[0].Rules[0].Conditions = map[string]any{"model": "changed-a"}
	policies[1].Name = "changed-b"
	policies[1].Rules[0].ID = "late-failure"
	// Force a real database error during the second policy's INSERT, after all
	// input and ownership checks. This is deterministic rollback evidence, not
	// a claim to reproduce every concurrent writer race.
	var create, remove string
	if db.dialect == "postgres" {
		if _, err := db.db.ExecContext(t.Context(), `CREATE FUNCTION reject_import_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'late-failure' THEN RAISE EXCEPTION 'public synthetic rejection'; END IF; RETURN NEW; END $$`); err != nil {
			t.Fatal(err)
		}
		create = `CREATE TRIGGER reject_import BEFORE INSERT ON policy_rules FOR EACH ROW EXECUTE FUNCTION reject_import_rule()`
		remove = `DROP TRIGGER reject_import ON policy_rules`
	} else {
		create = `CREATE TRIGGER reject_import BEFORE INSERT ON policy_rules WHEN NEW.id = 'late-failure' BEGIN SELECT RAISE(ABORT, 'public synthetic rejection'); END`
		remove = `DROP TRIGGER reject_import`
	}
	if _, err := db.db.ExecContext(t.Context(), create); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ImportPolicies(t.Context(), policies, false); err == nil {
		t.Fatal("injected database failure must reach the real write transaction")
	}
	after, err := db.ListPolicies(t.Context())
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("failed batch changed a policy or rule despite transaction rollback")
	}
	active, err := db.ActivePolicyRules(t.Context())
	if err != nil || !reflect.DeepEqual(warm, active) || db.policies.beginLoad() != gen {
		t.Fatal("failed batch changed or invalidated the warm active-rule cache")
	}
	if _, err := db.db.ExecContext(t.Context(), remove); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ImportPolicies(t.Context(), policies, true); err != nil || db.policies.beginLoad() != gen {
		t.Fatal("valid dry-run must not invalidate the cache")
	}
	if _, err := db.ImportPolicies(t.Context(), policies, false); err != nil {
		t.Fatal(err)
	}
	if db.policies.beginLoad() != gen+1 {
		t.Fatal("successful batch must invalidate once, not once per policy")
	}
	active, err = db.ActivePolicyRules(t.Context())
	if err != nil || len(active) != 2 {
		t.Fatal("successful batch must reload active rules")
	}
	seen := map[string]PolicyRule{}
	for _, r := range active {
		seen[r.ID] = r
	}
	if seen["rule-a"].Conditions["model"] != "changed-a" || seen["late-failure"].PolicyID != "import-b" {
		t.Fatal("successful batch left the previous warm rules visible")
	}
}

func TestPolicyImportExportSnapshot(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	batch := func(marker string) []Policy {
		var policies []Policy
		for _, id := range []string{"snapshot-a", "snapshot-b"} {
			policies = append(policies, Policy{ID: id, Name: marker, Enabled: true,
				Rules: []PolicyRule{{ID: id + "-rule", Name: marker, Actions: map[string]any{"marker": marker}}}})
		}
		return policies
	}
	if _, err := db.ImportPolicies(t.Context(), batch("initial"), false); err != nil {
		t.Fatal(err)
	}
	ready, done := make(chan struct{}), make(chan error, 1)
	go func() {
		<-ready
		for i := 0; i < 20; i++ {
			if _, err := db.ImportPolicies(t.Context(), batch(fmt.Sprintf("public-%d", i)), false); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	close(ready)
	// This concurrent control complements the single-SELECT implementation;
	// it does not claim deterministic scheduling between database read phases.
	for i := 0; i < 20; i++ {
		exported, err := db.ExportPolicies(t.Context())
		if err != nil || len(exported) != 2 {
			t.Errorf("snapshot export count=%d error=%v", len(exported), err)
			break
		}
		marker := exported[0].Name
		for _, p := range exported {
			if p.Name != marker || len(p.Rules) != 1 || p.Rules[0].Name != marker || p.Rules[0].Actions["marker"] != marker {
				t.Error("one export mixed parents/rules from different committed batches")
			}
		}
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("bounded concurrent import did not settle")
	}
}

func TestPolicyImportPrepareBeforeWrites(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	for _, value := range []any{json.Number("1e10000"), json.Number("not-a-number"), make(chan int)} {
		_, err := db.ImportPolicies(t.Context(), []Policy{
			{ID: "good-first", Name: "public"},
			{ID: "bad-second", Name: "public", Rules: []PolicyRule{{ID: "bad-rule", Actions: map[string]any{"nested": []any{value}}}}},
		}, false)
		if err == nil {
			t.Fatal("invalid opaque JSON must fail before writing even outside HTTP")
		}
		policies, err := db.ListPolicies(t.Context())
		if err != nil || len(policies) != 0 {
			t.Fatal("store preparation failure partially persisted the first policy")
		}
	}
}
