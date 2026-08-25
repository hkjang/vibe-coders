package store

import (
	"context"
	"os"
	"strings"
	"testing"
)

// isPostgresTest reports whether the suite is running against Postgres, which is the only
// driver that keeps the access counters this file reads.
func isPostgresTest() bool { return os.Getenv("TEST_POSTGRES_DSN") != "" }

// On SQLite the honest answer to "which tables are being scanned" is "this driver does
// not count that". Saying so matters: an empty list would otherwise read as "nothing to
// do" when it means "nothing measurable here".
func TestIndexAdviceSaysWhatItCannotSee(t *testing.T) {
	if isPostgresTest() {
		t.Skip("SQLite-specific: this is about the driver that keeps no counters")
	}
	db := openStoreForTest(t)
	defer db.Close()

	rep, err := db.IndexAdvice(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Limitations) == 0 {
		t.Fatal("no limitation recorded, so an empty advice list reads as a clean bill of health")
	}
	joined := strings.Join(rep.Limitations, " ")
	if !strings.Contains(joined, "Postgres") {
		t.Fatalf("the limitation does not say where the full picture is: %q", joined)
	}
	for _, it := range rep.Items {
		if it.Evidence == "" {
			t.Errorf("advice for %s has no evidence, so it cannot be argued with", it.Table)
		}
		if it.Reason == "" {
			t.Errorf("advice for %s has no reason", it.Table)
		}
	}
}

// A table with nothing but its primary key can only be searched by scanning, and that is
// knowable from the schema alone.
func TestIndexAdviceFlagsTablesWithNoIndexAtAll(t *testing.T) {
	if isPostgresTest() {
		t.Skip("the Postgres path gates on access counters, which a fresh schema has none of")
	}
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	rep, err := db.IndexAdvice(ctx)
	if err != nil {
		t.Fatal(err)
	}
	flagged := map[string]bool{}
	for _, it := range rep.Items {
		flagged[it.Table] = true
	}
	// response_logs gained an index; a table that still has none must be listed.
	if flagged["response_logs"] {
		t.Error("response_logs has an index now and should not be flagged as having none")
	}
	if len(flagged) == 0 {
		t.Fatal("no table flagged at all; the schema-only path is not running")
	}

	// And the claim has to be true: everything flagged really has no non-implicit index.
	live, err := db.LiveIndexes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	indexed := map[string]bool{}
	for _, idx := range live {
		if !idx.Implicit {
			indexed[idx.Table] = true
		}
	}
	for table := range flagged {
		if indexed[table] {
			t.Errorf("%s was flagged as having no index but has one", table)
		}
	}
}

// The Postgres path has to run against a real catalog: pg_stat_user_tables and
// pg_stat_user_indexes are easy to get subtly wrong, and a query that errors would take
// the whole admin page down.
func TestIndexAdviceRunsOnPostgres(t *testing.T) {
	if !isPostgresTest() {
		t.Skip("set TEST_POSTGRES_DSN")
	}
	db := openStoreForTest(t)
	defer db.Close()

	rep, err := db.IndexAdvice(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Limitations) != 0 {
		t.Fatalf("Postgres has the counters, so nothing should be recorded as unseeable: %v", rep.Limitations)
	}
	// A freshly migrated schema has no traffic, so every threshold should hold everything
	// back. Advice here would mean the guards are not working.
	if len(rep.Items) != 0 {
		t.Fatalf("advice produced from a schema with no traffic: %+v", rep.Items)
	}

	// An empty result is what the thresholds should produce here, which means it proves
	// nothing about the catalog queries themselves — a query returning no rows because it
	// is wrong looks identical. Check them directly.
	ctx := context.Background()
	stats, err := db.postgresTableStats(ctx)
	if err != nil {
		t.Fatalf("table stats: %v", err)
	}
	if len(stats) < 50 {
		t.Fatalf("pg_stat_user_tables returned %d rows for a schema with over a hundred tables; "+
			"the query is not reading this schema", len(stats))
	}
	for _, st := range stats {
		if st.Table == "" {
			t.Fatal("a stat row came back with no table name")
		}
	}
	if _, err := db.postgresUnusedIndexes(ctx); err != nil {
		t.Fatalf("unused index query: %v", err)
	}
}

func TestAdviceIsOrderedWorstFirst(t *testing.T) {
	items := []IndexAdvice{
		{Severity: "low", Table: "a"},
		{Severity: "high", Table: "z"},
		{Severity: "medium", Table: "b"},
		{Severity: "high", Table: "b"},
	}
	sortAdvice(items)
	want := []string{"high/b", "high/z", "medium/b", "low/a"}
	for i, w := range want {
		if got := items[i].Severity + "/" + items[i].Table; got != w {
			t.Fatalf("position %d is %s, want %s (full: %+v)", i, got, w, items)
		}
	}
}

func TestHumanBytes(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{512, "512 B"},
		{2048, "2.0 KiB"},
		{3 << 20, "3.0 MiB"},
		{5 << 30, "5.0 GiB"},
	}
	for _, c := range cases {
		if got := humanBytes(c.in); got != c.want {
			t.Errorf("humanBytes(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The judgement, with the counters supplied rather than generated. Every branch here is a
// decision an operator will act on, so each one is stated as a case: what the database
// reported, and what it means.
func TestAdviceForTable(t *testing.T) {
	cases := []struct {
		name         string
		stat         tableStat
		wantAdvice   bool
		wantSeverity string
		wantIn       string
	}{
		{"a table nobody has read yet says nothing, however big",
			tableStat{Table: "t", LiveTuples: 1_000_000, SeqScan: 5, HasNonPKIdx: false}, false, "", ""},
		{"a small table is allowed to be scanned",
			tableStat{Table: "t", LiveTuples: 100, SeqScan: 10_000, HasNonPKIdx: false}, false, "", ""},
		{"a big table read often with no index at all is the worst case",
			tableStat{Table: "t", LiveTuples: 50_000, SeqScan: 500, IdxScan: 0, HasNonPKIdx: false},
			true, "high", "no index other than the primary key"},
		{"indexed, and the index is doing the work",
			tableStat{Table: "t", LiveTuples: 50_000, SeqScan: 10, IdxScan: 5_000, HasNonPKIdx: true}, false, "", ""},
		{"indexed, but scanned more than it is looked up",
			tableStat{Table: "t", LiveTuples: 50_000, SeqScan: 300, SeqTupRead: 15_000_000, IdxScan: 200, HasNonPKIdx: true},
			true, "medium", "scanned more often than it is looked up"},
		{"scanned an order of magnitude more, on a large table",
			tableStat{Table: "t", LiveTuples: 500_000, SeqScan: 5_000, SeqTupRead: 2_500_000_000, IdxScan: 100, HasNonPKIdx: true},
			true, "high", "scanned more often than it is looked up"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := adviceForTable(tc.stat)
			if ok != tc.wantAdvice {
				t.Fatalf("advice=%v want %v (%+v)", ok, tc.wantAdvice, got)
			}
			if !ok {
				return
			}
			if got.Severity != tc.wantSeverity {
				t.Errorf("severity %q want %q", got.Severity, tc.wantSeverity)
			}
			if !strings.Contains(got.Reason, tc.wantIn) {
				t.Errorf("reason %q does not contain %q", got.Reason, tc.wantIn)
			}
			if got.Evidence == "" {
				t.Error("no evidence, so the recommendation cannot be argued with")
			}
			if got.Kind != "add" {
				t.Errorf("kind %q want add", got.Kind)
			}
		})
	}
}
