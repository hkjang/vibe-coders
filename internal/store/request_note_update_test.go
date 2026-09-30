package store

import (
	"context"
	"database/sql"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestRequestNoteSavePreservesCurrentColumnsAndReturnsCommittedRow(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	stale := RequestNote{RequestID: "note-preserve", Note: "old note", Tags: []string{"old-tag"}, CreatedBy: "old-actor"}
	if err := db.UpsertRequestNote(ctx, stale); err != nil {
		t.Fatal(err)
	}
	current := stale
	current.Note, current.Tags = "current note", []string{"current-tag", "한글"}
	if err := db.UpsertRequestNote(ctx, current); err != nil {
		t.Fatal(err)
	}
	stale.CreatedBy = "new-actor"
	got, err := db.SaveRequestNote(ctx, stale, true, true)
	stored, found, readErr := db.GetRequestNote(ctx, stale.RequestID)
	if err != nil || readErr != nil || !found || !reflect.DeepEqual(got, stored) || got.Note != current.Note || !reflect.DeepEqual(got.Tags, current.Tags) || got.CreatedBy != "new-actor" || got.UpdatedAt.IsZero() {
		t.Fatal("preserve did not retain current columns and return its committed metadata")
	}
	for _, preserveNote := range []bool{false, true} {
		input := RequestNote{RequestID: stale.RequestID, Note: "replacement", Tags: []string{"replacement"}, CreatedBy: "next-actor"}
		before := got
		got, err = db.SaveRequestNote(ctx, input, preserveNote, !preserveNote)
		if err != nil || (preserveNote && (got.Note != before.Note || !reflect.DeepEqual(got.Tags, input.Tags))) || (!preserveNote && (got.Note != input.Note || !reflect.DeepEqual(got.Tags, before.Tags))) {
			t.Fatal("one-field replacement changed a preserved column")
		}
	}
}

func TestRequestNoteSaveCreatesEmptyPreservedFieldsAndClearsReplacement(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	input := RequestNote{RequestID: "note-empty", Note: "ignored", Tags: []string{"ignored"}, CreatedBy: "actor"}
	got, err := db.SaveRequestNote(t.Context(), input, true, true)
	if err != nil || got.Note != "" || got.Tags == nil || len(got.Tags) != 0 || got.UpdatedAt.IsZero() {
		t.Fatal("new preserved fields must be empty, with confirmed stored metadata")
	}
	input.Note, input.Tags = "normal", []string{"normal"}
	if _, err := db.SaveRequestNote(t.Context(), input, false, false); err != nil {
		t.Fatal(err)
	}
	got, err = db.SaveRequestNote(t.Context(), RequestNote{RequestID: input.RequestID}, false, false)
	if err != nil || got.Note != "" || len(got.Tags) != 0 {
		t.Fatal("unpreserved empty values must still clear both fields")
	}
}

func TestRequestNoteSavePreservesExactStoredColumns(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, nullFields := range []bool{false, true} {
		var tags, note any = " #한글 ,first@example.com,first@example.com ", " \ufeffexact\u0085 "
		if nullFields {
			tags, note = nil, nil
		}
		_, err := db.db.ExecContext(t.Context(), db.bind(`INSERT INTO request_notes (request_id, tags, note, updated_at)
			VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET tags = excluded.tags, note = excluded.note`),
			"exact-columns", tags, note, formatTime(time.Now().UTC()))
		if err != nil {
			t.Fatal(err)
		}
		got, err := db.SaveRequestNote(t.Context(), RequestNote{RequestID: "exact-columns", Note: "must not replace", Tags: []string{"must not replace"}}, true, true)
		if err != nil || got.UpdatedAt.IsZero() {
			t.Fatal("failed to preserve imported row")
		}
		var storedTags, storedNote sql.NullString
		if err := db.db.QueryRowContext(t.Context(), `SELECT tags, note FROM request_notes WHERE request_id = 'exact-columns'`).Scan(&storedTags, &storedNote); err != nil {
			t.Fatal(err)
		}
		if storedTags.Valid == nullFields || storedNote.Valid == nullFields || (!nullFields && (storedTags.String != tags || storedNote.String != note)) {
			t.Fatal("preserved raw columns were normalized or nulls replaced")
		}
	}
}

func TestRequestNoteSaveConcurrentDisjointPreservation(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	seed := RequestNote{RequestID: "note-concurrent", Note: "seed", Tags: []string{"seed"}}
	if err := db.UpsertRequestNote(t.Context(), seed); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var workers sync.WaitGroup
	for _, tagsWriter := range []bool{false, true} {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			input := RequestNote{RequestID: seed.RequestID, Note: "new-note", Tags: []string{"new-tag"}, CreatedBy: "writer"}
			got, err := db.SaveRequestNote(t.Context(), input, tagsWriter, !tagsWriter)
			if err != nil || got.UpdatedAt.IsZero() || (tagsWriter && !reflect.DeepEqual(got.Tags, input.Tags)) || (!tagsWriter && got.Note != input.Note) {
				t.Error("concurrent writer did not receive its own committed replacement")
			}
		}()
	}
	close(start)
	workers.Wait()
	got, found, err := db.GetRequestNote(t.Context(), seed.RequestID)
	if err != nil || !found || got.Note != "new-note" || !reflect.DeepEqual(got.Tags, []string{"new-tag"}) {
		t.Fatal("disjoint preservation lost a committed field")
	}
}

func TestRequestNoteSaveTransactionFailuresReturnNoSnapshot(t *testing.T) {
	for _, failure := range []string{"write", "snapshot", "commit"} {
		t.Run(failure, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			seed := RequestNote{RequestID: "note-failure", Note: "original", Tags: []string{"original"}, CreatedBy: "original", UpdatedAt: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)}
			if err := db.UpsertRequestNote(t.Context(), seed); err != nil {
				t.Fatal(err)
			}
			installRequestNoteFailure(t, db, failure)
			got, err := db.SaveRequestNote(t.Context(), RequestNote{RequestID: seed.RequestID, Note: "replacement", Tags: []string{"replacement"}, CreatedBy: "replacement"}, false, false)
			if err == nil || !reflect.DeepEqual(got, RequestNote{}) {
				t.Fatal("failed transaction returned a success snapshot")
			}
			after, found, err := db.GetRequestNote(t.Context(), seed.RequestID)
			if err != nil || !found || !reflect.DeepEqual(after, seed) {
				t.Fatal("failed transaction changed fields or metadata")
			}
		})
	}
}

func installRequestNoteFailure(t *testing.T, db *SQLStore, failure string) {
	t.Helper()
	var statements []string
	switch failure {
	case "write":
		statements = []string{`CREATE TRIGGER note_reject BEFORE UPDATE ON request_notes BEGIN SELECT RAISE(FAIL, 'synthetic note failure'); END`}
		if db.dialect == "postgres" {
			statements = []string{`ALTER TABLE request_notes ADD CONSTRAINT note_reject CHECK (note <> 'replacement')`}
		}
	case "snapshot":
		statements = []string{`CREATE TRIGGER note_bad_time AFTER UPDATE ON request_notes BEGIN UPDATE request_notes SET updated_at = 'not-a-time' WHERE request_id = NEW.request_id; END`}
		if db.dialect == "postgres" {
			statements = []string{
				`CREATE FUNCTION note_bad_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := 'not-a-time'; RETURN NEW; END $$`,
				`CREATE TRIGGER note_bad_time BEFORE UPDATE ON request_notes FOR EACH ROW EXECUTE FUNCTION note_bad_time()`,
			}
		}
	case "commit":
		statements = []string{
			`CREATE TABLE note_fk_parent (id INTEGER PRIMARY KEY)`,
			`CREATE TABLE note_fk_child (parent_id INTEGER REFERENCES note_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
		}
		if db.dialect == "postgres" {
			statements = append(statements,
				`CREATE FUNCTION note_bad_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO note_fk_child VALUES (1); RETURN NEW; END $$`,
				`CREATE TRIGGER note_bad_commit AFTER UPDATE ON request_notes FOR EACH ROW EXECUTE FUNCTION note_bad_commit()`)
		} else {
			statements = append([]string{`PRAGMA foreign_keys = ON`}, statements...)
			statements = append(statements, `CREATE TRIGGER note_bad_commit AFTER UPDATE ON request_notes BEGIN INSERT INTO note_fk_child VALUES (1); END`)
		}
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRequestNoteSaveCanceledContextDoesNotWrite(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	got, err := db.SaveRequestNote(ctx, RequestNote{RequestID: "canceled", Note: "new"}, false, false)
	if err == nil || !reflect.DeepEqual(got, RequestNote{}) {
		t.Fatal("canceled transaction returned a success snapshot")
	}
	_, found, err := db.GetRequestNote(t.Context(), "canceled")
	if err != nil || found {
		t.Fatal("canceled write created a row")
	}
}
