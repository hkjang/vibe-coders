package store

import (
	"strings"
	"testing"
)

// The SQL view and the drift checker have to be reading the same schema. If the view
// misses an index the drift checker knows about, an operator comparing the two concludes
// the index was added by hand when the build declares it.
func TestMigrationSQLListsExactlyTheDeclaredIndexes(t *testing.T) {
	rep := migrationSQLFor("sqlite")

	inView := map[string]bool{}
	for _, st := range rep.Statements {
		if st.Kind != "create_index" {
			continue
		}
		if st.Name == "" {
			t.Fatalf("statement %d classified as an index with no name: %s", st.Seq, st.SQL)
		}
		inView[st.Name] = true
	}
	for _, idx := range DeclaredIndexes() {
		if !inView[idx.Name] {
			t.Fatalf("index %q is in DeclaredIndexes but not in the SQL view; an operator "+
				"comparing the two would read it as hand-added", idx.Name)
		}
		delete(inView, idx.Name)
	}
	for name := range inView {
		t.Fatalf("the SQL view reports index %q that DeclaredIndexes does not know about", name)
	}
	if rep.Counts.CreateIndex != len(DeclaredIndexes()) {
		t.Fatalf("index count %d != declared %d", rep.Counts.CreateIndex, len(DeclaredIndexes()))
	}
}

// Seq is presented as apply order, and an ALTER TABLE read before its CREATE TABLE is
// nonsense. It has to be the position in the list, not a sort of it.
func TestMigrationSQLKeepsApplyOrder(t *testing.T) {
	stmts := migrationStatements()
	rep := migrationSQLFor("sqlite")

	if len(rep.Statements) != len(stmts) {
		t.Fatalf("view has %d statements, migrations have %d", len(rep.Statements), len(stmts))
	}
	for i, st := range rep.Statements {
		if st.Seq != i+1 {
			t.Fatalf("statement at position %d reports seq %d", i, st.Seq)
		}
		if st.SQL != stmts[i] {
			t.Fatalf("seq %d is not the statement at that position:\n view: %.80s\n list: %.80s",
				st.Seq, st.SQL, stmts[i])
		}
	}
	if got := rep.Counts.Total; got != len(stmts) {
		t.Fatalf("counts.total %d != %d", got, len(stmts))
	}
	if sum := rep.Counts.CreateTable + rep.Counts.CreateIndex + rep.Counts.AddColumn + rep.Counts.Other; sum != rep.Counts.Total {
		t.Fatalf("kind counts sum to %d, total is %d", sum, rep.Counts.Total)
	}
}

// On Postgres the statement that ran is not the one in the source. Showing the source
// would have an operator compare a BLOB column against a BYTEA one and see drift that is
// not there, so the view renders through the same function Migrate does.
func TestMigrationSQLShowsWhatPostgresActuallyRan(t *testing.T) {
	pg := migrationSQLFor("postgres")
	if pg.Counts.Rewritten == 0 {
		t.Fatal("no statement was rewritten for postgres; the view is showing the sqlite spelling")
	}
	rewritten := 0
	for _, st := range pg.Statements {
		if st.DeclaredSQL == "" {
			if strings.Contains(strings.ToUpper(st.SQL), " BLOB") {
				t.Fatalf("seq %d still says BLOB and is not marked as rewritten: %.80s", st.Seq, st.SQL)
			}
			continue
		}
		rewritten++
		if st.SQL == st.DeclaredSQL {
			t.Fatalf("seq %d carries a declared_sql identical to the rendered one", st.Seq)
		}
		if st.SQL != renderForDialect(st.DeclaredSQL, "postgres") {
			t.Fatalf("seq %d rendered differently from Migrate", st.Seq)
		}
	}
	if rewritten != pg.Counts.Rewritten {
		t.Fatalf("counts.rewritten %d, statements carrying declared_sql %d", pg.Counts.Rewritten, rewritten)
	}

	// SQLite runs the statements as written; marking any of them as rewritten would tell
	// an operator a difference exists where there is none.
	lite := migrationSQLFor("sqlite")
	if lite.Counts.Rewritten != 0 {
		t.Fatalf("sqlite reports %d rewritten statements", lite.Counts.Rewritten)
	}
	for _, st := range lite.Statements {
		if st.DeclaredSQL != "" {
			t.Fatalf("sqlite seq %d carries a declared_sql", st.Seq)
		}
	}
}

// Grouping by table is how an operator finds the statement they want. A statement filed
// under no table is invisible to that, so every one of them has to name one.
func TestMigrationSQLAttributesEveryStatementToATable(t *testing.T) {
	rep := migrationSQLFor("sqlite")
	for _, st := range rep.Statements {
		if st.Table == "" {
			t.Fatalf("seq %d (%s) names no table: %.100s", st.Seq, st.Kind, st.SQL)
		}
		if st.Kind == "add_column" && st.Column == "" {
			t.Fatalf("seq %d is an add_column with no column named: %.100s", st.Seq, st.SQL)
		}
	}
	declared := DeclaredTables()
	if len(rep.Tables) != len(declared) {
		t.Fatalf("view lists %d tables, DeclaredTables has %d", len(rep.Tables), len(declared))
	}
	for _, name := range rep.Tables {
		if _, ok := declared[name]; !ok {
			t.Fatalf("view lists table %q that DeclaredTables does not have", name)
		}
	}
}

// The list is not the whole story on Postgres: Migrate widens column types afterwards.
// Presenting it as complete would leave an operator hunting for a REAL column that the
// database no longer has.
func TestMigrationSQLDisclosesPostMigrationChangesOnPostgres(t *testing.T) {
	if len(migrationSQLFor("postgres").PostMigration) == 0 {
		t.Fatal("postgres report does not mention the column widening Migrate does after the list")
	}
	if len(migrationSQLFor("sqlite").PostMigration) != 0 {
		t.Fatal("sqlite report claims post-migration changes that only happen on postgres")
	}
}
