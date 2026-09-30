package store

import (
	"reflect"
	"testing"
)

func TestRuntimeFlagBatchDriverCommitFailureCleansConnection(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	// Force subsequent operations to reuse the connection whose driver COMMIT
	// fails. database/sql marks the Tx done even if SQLite keeps its SQL tx open.
	db.db.SetMaxOpenConns(1)
	keys := []string{"test.commit.a", "test.commit.b"}
	before, err := db.SaveRuntimeFlagBatch(t.Context(), []RuntimeFlag{
		{Key: keys[0], Value: "old-a", UpdatedBy: "original", Note: "original metadata"},
		{Key: keys[1], Value: "old-b", UpdatedBy: "original", Note: "original metadata"},
	}, keys)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE flag_fk_parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE flag_fk_child (parent_id INTEGER REFERENCES flag_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
	}
	dropTrigger := `DROP TRIGGER flag_bad_commit`
	if db.dialect == "postgres" {
		statements = append(statements,
			`CREATE FUNCTION flag_bad_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO flag_fk_child VALUES (1); RETURN NEW; END $$`,
			`CREATE TRIGGER flag_bad_commit AFTER UPDATE ON runtime_flags FOR EACH ROW EXECUTE FUNCTION flag_bad_commit()`)
		dropTrigger += ` ON runtime_flags`
	} else {
		statements = append([]string{`PRAGMA foreign_keys = ON`}, statements...)
		statements = append(statements, `CREATE TRIGGER flag_bad_commit AFTER UPDATE ON runtime_flags BEGIN INSERT INTO flag_fk_child VALUES (1); END`)
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	updates := []RuntimeFlag{
		{Key: keys[0], Value: "new-a", UpdatedBy: "replacement"},
		{Key: keys[1], Value: "new-b", UpdatedBy: "replacement"},
	}
	validated := false
	got, err := db.SaveRuntimeFlagBatchValidated(t.Context(), updates, keys, func(snapshot map[string]RuntimeFlag) error {
		validated = true
		if snapshot[keys[0]].Value != "new-a" || snapshot[keys[1]].Value != "new-b" {
			t.Error("validation did not observe both provisional writes")
		}
		return nil
	})
	if !validated || err == nil || got != nil {
		t.Fatal("driver commit failure returned a success snapshot or failed before validation")
	}
	after, err := db.GetRuntimeFlagSnapshot(t.Context(), keys)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("failed commit left uncommitted values or metadata on a reused connection")
	}
	var children int
	if err := db.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM flag_fk_child`).Scan(&children); err != nil || children != 0 {
		t.Fatal("failed commit retained its trigger side effects")
	}
	if _, err := db.db.ExecContext(t.Context(), dropTrigger); err != nil {
		t.Fatal(err)
	}
	got, err = db.SaveRuntimeFlagBatch(t.Context(), updates, keys)
	after, readErr := db.GetRuntimeFlagSnapshot(t.Context(), keys)
	if err != nil || readErr != nil || !reflect.DeepEqual(got, after) || got[keys[0]].Value != "new-a" || got[keys[1]].Value != "new-b" {
		t.Fatal("failed commit left the pool unable to perform a new independent transaction")
	}
}
