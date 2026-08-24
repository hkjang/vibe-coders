package store

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func seedPolicy(t *testing.T, db *SQLStore, id, ruleName, secretAction string, enabled bool) {
	t.Helper()
	err := db.UpsertPolicyWithRules(context.Background(),
		Policy{ID: id, Name: id, Enabled: enabled, Priority: 100, RolloutPercent: 100, CreatedAt: time.Now().UTC()},
		[]PolicyRule{{
			ID: id + "-r1", PolicyID: id, Name: ruleName, Enabled: true, Priority: 10,
			Conditions: map[string]any{}, Actions: map[string]any{"secret_action": secretAction},
			CreatedAt: time.Now().UTC(),
		}})
	if err != nil {
		t.Fatalf("upsert %s: %v", id, err)
	}
}

func ruleNames(rules []PolicyRule) []string {
	out := make([]string, 0, len(rules))
	for _, r := range rules {
		out = append(out, r.Name)
	}
	return out
}

// Proving the cache caches by timing is flaky, so the rows are changed behind the store's
// back — a raw UPDATE that never invalidates — and the read is expected to still return
// the old rule set.
func TestActivePolicyRulesServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedPolicy(t, db, "p1", "first", "detect", true)
	if got, err := db.ActivePolicyRules(ctx); err != nil || len(got) != 1 || got[0].Name != "first" {
		t.Fatalf("first read: %v %v", ruleNames(got), err)
	}

	if _, err := db.db.ExecContext(ctx, db.bind(
		`UPDATE policy_rules SET name = ? WHERE policy_id = ?`), "behind-its-back", "p1"); err != nil {
		t.Fatal(err)
	}

	got, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "first" {
		t.Fatalf("second read went to the database instead of the cache: %v", ruleNames(got))
	}
}

// A governance rule is enforcement. An operator who disables a policy has to see it stop
// being enforced on the very next request — a stale window here is a request judged by a
// rule the operator has already withdrawn.
func TestPolicyWritesAreEnforcedImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedPolicy(t, db, "p1", "first", "detect", true)
	if _, err := db.ActivePolicyRules(ctx); err != nil { // prime the cache
		t.Fatal(err)
	}

	seedPolicy(t, db, "p1", "edited", "block", true)
	got, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "edited" {
		t.Fatalf("edit not visible: %v", ruleNames(got))
	}
	if got[0].Actions["secret_action"] != "block" {
		t.Fatalf("the rule's action is stale: %v", got[0].Actions)
	}

	seedPolicy(t, db, "p2", "second", "mask", true)
	if got, _ := db.ActivePolicyRules(ctx); len(got) != 2 {
		t.Fatalf("added policy not enforced: %v", ruleNames(got))
	}

	// Disabling is the one that matters most: it must take effect at once.
	seedPolicy(t, db, "p2", "second", "mask", false)
	got, err = db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "edited" {
		t.Fatalf("a disabled policy is still being enforced: %v", ruleNames(got))
	}
}

// A caller must not be able to change the rule set every later request will be judged by.
func TestActivePolicyRulesReturnsACopy(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedPolicy(t, db, "p1", "first", "detect", true)

	loaded, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	loaded[0].Name = "mutated-after-load"
	if got, _ := db.ActivePolicyRules(ctx); got[0].Name != "first" {
		t.Fatalf("mutating the loaded slice leaked into the cache: %q", got[0].Name)
	}

	cached, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cached[0].Name = "mutated-after-hit"
	if got, _ := db.ActivePolicyRules(ctx); got[0].Name != "first" {
		t.Fatalf("mutating a cache hit leaked into the cache: %q", got[0].Name)
	}
}

// The cache shares each rule's Conditions and Actions maps rather than copying them —
// copying per request would give back most of what caching the decode saved. That is only
// safe while nothing writes to them, and a map is easy to write to by accident, so the
// build checks instead of the comment being the only guard.
func TestGovernanceRulesAreTreatedAsReadOnly(t *testing.T) {
	write := regexp.MustCompile(`\.(Conditions|Actions)\[[^\]]*\]\s*=[^=]|delete\(\s*[a-zA-Z_][a-zA-Z0-9_.]*\.(Conditions|Actions)\s*,`)
	roots := []string{".", filepath.Join("..", "proxy")}
	checked := 0
	for _, root := range roots {
		files, err := filepath.Glob(filepath.Join(root, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			checked++
			for _, line := range strings.Split(string(raw), "\n") {
				if write.MatchString(line) {
					t.Errorf("%s writes into a rule's Conditions/Actions map:\n    %s\n"+
						"Those maps are shared by every request served from the policy cache, so a write "+
						"here changes what other requests are judged by. Build the map you need locally, "+
						"or copy it in policyCache before handing it out.", f, strings.TrimSpace(line))
				}
			}
		}
	}
	if checked < 100 {
		t.Fatalf("only %d source files scanned; the file walk has broken", checked)
	}
}
