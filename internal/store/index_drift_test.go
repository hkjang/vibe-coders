package store

import (
	"context"
	"strings"
	"testing"
)

func driftItem(t *testing.T, rep IndexDriftReport, kind, name string) IndexDriftItem {
	t.Helper()
	for _, it := range rep.Items {
		if it.Kind == kind && it.Name == name {
			return it
		}
	}
	var got []string
	for _, it := range rep.Items {
		got = append(got, it.Kind+":"+it.Name)
	}
	t.Fatalf("no %s item for %q; report had %v", kind, name, got)
	return IndexDriftItem{}
}

// The check that earns its keep on every run: a database the migrations just created has
// to match what they declare. An index statement that silently fails to apply, or one
// added to the list in a form the database spells differently, shows up here rather than
// as a slow query months later.
func TestIndexDriftIsCleanOnAFreshDatabase(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()

	rep, err := db.IndexDrift(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rep.DeclaredCount == 0 {
		t.Fatal("no declared indexes were parsed; the migration reader has stopped matching")
	}
	if !rep.InSync() {
		for _, it := range rep.Items {
			t.Errorf("[%s] %s on %s — %s", it.Kind, it.Name, it.Table, it.Detail)
		}
		t.Fatalf("a freshly migrated %s database already differs from the declared schema", rep.Dialect)
	}
	if rep.LiveCount != rep.DeclaredCount {
		t.Fatalf("declared %d indexes but found %d live with no drift reported, which cannot both be true",
			rep.DeclaredCount, rep.LiveCount)
	}
}

// An index somebody added by hand in production works, and is missing everywhere else.
func TestIndexDriftDetectsAHandAddedIndex(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if _, err := db.db.ExecContext(ctx,
		`CREATE INDEX idx_hand_added_probe ON request_logs(user_agent)`); err != nil {
		t.Fatal(err)
	}

	rep, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	item := driftItem(t, rep, "undeclared", "idx_hand_added_probe")
	if item.Table != "request_logs" {
		t.Fatalf("wrong table: %q", item.Table)
	}
	if item.Live == nil || len(item.Live.Columns) != 1 || item.Live.Columns[0] != "user_agent" {
		t.Fatalf("columns not reported: %+v", item.Live)
	}
	if !strings.Contains(item.Fix, "migrationStatements") {
		t.Fatalf("fix does not say where to declare it: %q", item.Fix)
	}
}

// An index somebody dropped. Nothing fails; queries just get slower.
func TestIndexDriftDetectsADroppedIndex(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if _, err := db.db.ExecContext(ctx, `DROP INDEX idx_redteam_remediations_status`); err != nil {
		t.Fatal(err)
	}

	rep, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	item := driftItem(t, rep, "missing", "idx_redteam_remediations_status")
	if item.Declared == nil || item.Declared.Table != "redteam_remediations" {
		t.Fatalf("declared side not reported: %+v", item.Declared)
	}
	if !strings.Contains(strings.ToUpper(item.Fix), "CREATE INDEX") {
		t.Fatalf("fix is not the statement that restores it: %q", item.Fix)
	}
}

// The one nothing else would catch. CREATE INDEX IF NOT EXISTS matches on the name, so a
// database holding an older definition keeps it and the migration still reports success.
func TestIndexDriftDetectsARedefinedIndex(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if _, err := db.db.ExecContext(ctx, `DROP INDEX idx_redteam_remediations_status`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx,
		`CREATE INDEX idx_redteam_remediations_status ON redteam_remediations(created_at)`); err != nil {
		t.Fatal(err)
	}

	// Re-running the migrations must not paper over it: the name is there, so
	// IF NOT EXISTS does nothing.
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	rep, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	item := driftItem(t, rep, "mismatched", "idx_redteam_remediations_status")
	if item.Declared == nil || item.Live == nil {
		t.Fatalf("both sides must be reported so an operator can see the difference: %+v", item)
	}
	if item.Live.Signature() == item.Declared.Signature() {
		t.Fatalf("reported as mismatched but the signatures are equal: %s", item.Live.Signature())
	}
	if !strings.Contains(strings.ToUpper(item.Fix), "DROP INDEX") {
		t.Fatalf("a redefined index cannot be fixed without dropping it first: %q", item.Fix)
	}
}

// Worst-first ordering. An index that is silently wrong is worse than one that is
// silently slow, which is worse than one the next environment will lack — an operator
// reading the top of the list should be reading the thing that matters most. The three
// kinds have to be present at once for the order to mean anything.
func TestIndexDriftReportsWorstFirst(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	exec := func(q string) {
		t.Helper()
		if _, err := db.db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// mismatched: same name, different columns.
	exec(`DROP INDEX idx_redteam_remediations_status`)
	exec(`CREATE INDEX idx_redteam_remediations_status ON redteam_remediations(created_at)`)
	// missing: declared, dropped.
	exec(`DROP INDEX idx_prompt_logs_request_id`)
	// undeclared: present, never declared.
	exec(`CREATE INDEX idx_hand_added_probe ON request_logs(user_agent)`)

	rep, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, it := range rep.Items {
		kinds = append(kinds, it.Kind)
	}
	if len(kinds) != 3 {
		t.Fatalf("expected one item of each kind, got %v", kinds)
	}
	want := []string{"mismatched", "missing", "undeclared"}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("report ordered %v, want %v", kinds, want)
		}
	}
}

// Both drivers hand the definition back as a CREATE INDEX statement, but they spell it
// differently. If the parser normalised only one spelling, every index would read as
// mismatched on the other driver.
func TestParseCreateIndexAcceptsBothDialects(t *testing.T) {
	cases := []struct {
		name string
		ddl  string
		want string
	}{
		{"migration form",
			"CREATE INDEX IF NOT EXISTS idx_a ON request_logs(api_key_id, created_at)",
			"request_logs(api_key_id,created_at) unique=false"},
		{"postgres indexdef",
			"CREATE INDEX idx_a ON public.request_logs USING btree (api_key_id, created_at)",
			"request_logs(api_key_id,created_at) unique=false"},
		{"unique, quoted, schema-qualified",
			`CREATE UNIQUE INDEX idx_a ON "public"."request_logs" USING btree ("api_key_id")`,
			"request_logs(api_key_id) unique=true"},
		{"descending and null ordering",
			"CREATE INDEX idx_a ON request_logs USING btree (created_at DESC NULLS LAST)",
			"request_logs(created_at) unique=false"},
		{"operator class",
			"CREATE INDEX idx_a ON request_logs USING btree (model text_pattern_ops)",
			"request_logs(model) unique=false"},
		{"partial index keeps its key columns and drops the predicate",
			"CREATE INDEX idx_a ON request_logs USING btree (created_at) WHERE (status_code > 400)",
			"request_logs(created_at) unique=false"},
		{"expression index",
			"CREATE INDEX idx_a ON request_logs USING btree (lower(model), created_at)",
			"request_logs(lower(model),created_at) unique=false"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info, ok := parseCreateIndex(tc.ddl)
			if !ok {
				t.Fatalf("did not parse: %s", tc.ddl)
			}
			if got := info.Signature(); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}

	for _, notAnIndex := range []string{
		"CREATE TABLE IF NOT EXISTS request_logs (id TEXT PRIMARY KEY)",
		"ALTER TABLE request_logs ADD COLUMN model TEXT",
		"CREATE INDEX idx_a ON request_logs",
	} {
		if _, ok := parseCreateIndex(notAnIndex); ok {
			t.Fatalf("parsed something that is not a usable CREATE INDEX: %s", notAnIndex)
		}
	}
}

// The declared list has to come from the statements Migrate runs. If it were a second
// copy, this is where it would go stale.
func TestDeclaredIndexesComeFromTheMigrations(t *testing.T) {
	declared := DeclaredIndexes()
	if len(declared) < 100 {
		t.Fatalf("only %d indexes parsed out of the migrations; the reader has stopped matching", len(declared))
	}
	seen := map[string]string{}
	for _, idx := range declared {
		if idx.Table == "" || len(idx.Columns) == 0 {
			t.Errorf("index %q parsed with no table or columns", idx.Name)
		}
		if prev, dup := seen[idx.Name]; dup {
			t.Errorf("index name %q is declared twice (%s and %s); CREATE INDEX IF NOT EXISTS "+
				"would apply whichever comes first and silently skip the other",
				idx.Name, prev, idx.Signature())
		}
		seen[idx.Name] = idx.Signature()
	}
}
