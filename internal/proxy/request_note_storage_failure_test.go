package proxy

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These are handler/storage fault tests, not browser or Server.Routes coverage.
// Each uses an isolated SQLite database or PostgreSQL schema and a real session.
func TestRequestNoteStorageUnavailableIsNotEmptyOrSuccessful(t *testing.T) {
	f := newNoteStorageFailureFixture(t, false)
	f.exec(t, `ALTER TABLE request_notes RENAME TO unavailable_request_notes`)
	for _, tc := range []struct{ method, code, message string }{
		{http.MethodGet, "note_failed", "request note could not be loaded"},
		{http.MethodPatch, "note_save_failed", "request note could not be saved"},
		{http.MethodDelete, "note_delete_failed", "request note could not be deleted"},
	} {
		assertNoteStorageError(t, f.request(t, tc.method, `{"preserve_fields":[],"note":"replacement","tags":["new"]}`), tc.code, tc.message)
		f.assertNoAudit(t)
	}
	f.exec(t, `ALTER TABLE unavailable_request_notes RENAME TO request_notes`)
	f.assertOriginal(t)
}

func TestRequestNoteStoragePatchRollbackHasNoSuccessOrAudit(t *testing.T) {
	for _, failure := range []string{"write", "snapshot_missing", "snapshot_invalid_time"} {
		t.Run(failure, func(t *testing.T) {
			f := newNoteStorageFailureFixture(t, false)
			var sqlite, postgres []string
			switch failure {
			case "write":
				sqlite = []string{`CREATE TRIGGER note_write_fault BEFORE UPDATE ON request_notes BEGIN SELECT RAISE(FAIL, 'synthetic-private-storage-detail'); END`}
				postgres = []string{`ALTER TABLE request_notes ADD CONSTRAINT synthetic_private_storage_detail CHECK (note <> 'replacement')`}
			case "snapshot_missing":
				sqlite = []string{`CREATE TRIGGER note_snapshot_fault AFTER UPDATE ON request_notes BEGIN DELETE FROM request_notes WHERE request_id = NEW.request_id; END`}
				postgres = []string{
					`CREATE FUNCTION note_snapshot_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM request_notes WHERE request_id = NEW.request_id; RETURN NEW; END $$`,
					`CREATE TRIGGER note_snapshot_fault AFTER UPDATE ON request_notes FOR EACH ROW EXECUTE FUNCTION note_snapshot_fault()`,
				}
			case "snapshot_invalid_time":
				sqlite = []string{`CREATE TRIGGER note_snapshot_fault AFTER UPDATE ON request_notes BEGIN UPDATE request_notes SET updated_at = 'synthetic-private-storage-detail' WHERE request_id = NEW.request_id; END`}
				postgres = []string{
					`CREATE FUNCTION note_snapshot_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := 'synthetic-private-storage-detail'; RETURN NEW; END $$`,
					`CREATE TRIGGER note_snapshot_fault BEFORE UPDATE ON request_notes FOR EACH ROW EXECUTE FUNCTION note_snapshot_fault()`,
				}
			}
			f.execDialect(t, sqlite, postgres)
			assertNoteStorageError(t, f.request(t, http.MethodPatch, `{"preserve_fields":[],"note":"replacement","tags":["new"]}`), "note_save_failed", "request note could not be saved")
			f.assertOriginal(t)
			f.assertNoAudit(t)
		})
	}
}

func TestRequestNoteStorageResponseOwnsCommittedProjectedSnapshot(t *testing.T) {
	for _, rawReader := range []bool{false, true} {
		name := "projected"
		if rawReader {
			name = "raw"
		}
		t.Run(name, func(t *testing.T) {
			f := newNoteStorageFailureFixture(t, rawReader)
			// Capture the actual committed row at the post-commit audit boundary,
			// then install a distinct later row. A follow-up read cannot produce the
			// correct response or timestamp, even if it applies the right masking.
			f.exec(t, `CREATE TABLE note_commit_capture AS SELECT * FROM request_notes WHERE 1 = 0`)
			capture := `INSERT INTO note_commit_capture SELECT * FROM request_notes;`
			overwrite := `UPDATE request_notes SET note = 'later note', tags = 'later', created_by = 'later-editor', updated_at = '2035-01-01T00:00:00Z';`
			f.execDialect(t, []string{
				`CREATE TRIGGER note_after_audit AFTER INSERT ON admin_audit_logs WHEN NEW.action = 'request_note.upsert' BEGIN ` + capture + overwrite + ` END`,
			}, []string{
				`CREATE FUNCTION note_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` + capture + overwrite + ` RETURN NEW; END $$`,
				`CREATE TRIGGER note_after_audit AFTER INSERT ON admin_audit_logs FOR EACH ROW WHEN (NEW.action = 'request_note.upsert') EXECUTE FUNCTION note_after_audit()`,
			})
			response := f.request(t, http.MethodPatch, `{"preserve_fields":[],"note":"contact first@synthetic.example","tags":["first@synthetic.example","second@synthetic.example"]}`)
			var got requestNoteAppResponse
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &got) != nil {
				t.Fatal("committed PATCH did not return its app DTO")
			}
			var committed store.RequestNote
			var tags, timestamp string
			if err := f.raw.QueryRowContext(t.Context(), `SELECT request_id, tags, note, created_by, updated_at FROM note_commit_capture`).Scan(
				&committed.RequestID, &tags, &committed.Note, &committed.CreatedBy, &timestamp); err != nil {
				t.Fatal("post-commit capture was not recorded")
			}
			var err error
			committed.UpdatedAt, err = time.Parse(time.RFC3339Nano, timestamp)
			committed.Tags = strings.Split(tags, ",")
			if err != nil || committed.UpdatedAt.IsZero() || committed.UpdatedAt.Equal(f.seed.UpdatedAt) ||
				committed.RequestID != f.seed.RequestID || committed.Note != "contact first@synthetic.example" ||
				!reflect.DeepEqual(committed.Tags, []string{"first@synthetic.example", "second@synthetic.example"}) ||
				committed.CreatedBy != "admin_"+hashProxyKey(f.token)[:12] {
				t.Fatal("captured row was not this PATCH's original values, actor and actual commit metadata")
			}
			want := requestNoteAppResponse{RequestNote: committed, Exists: true, RedactedFields: []string{}}
			if !rawReader {
				want.Note = "contact [REDACTED_EMAIL]"
				want.Tags = []string{"[REDACTED_EMAIL]", "[REDACTED_EMAIL]"}
				want.RedactedFields = []string{"note", "tags"}
				if strings.Contains(response.Body.String(), "synthetic.example") {
					t.Fatal("projected committed response leaked a synthetic original")
				}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("response did not retain its own committed timestamp, fields and projection metadata")
			}
			stored, found, err := f.db.GetRequestNote(t.Context(), f.seed.RequestID)
			if err != nil || !found || stored.Note != "later note" || !reflect.DeepEqual(stored.Tags, []string{"later"}) || stored.CreatedBy != "later-editor" || stored.UpdatedAt.Year() != 2035 || stored.UpdatedAt.Equal(committed.UpdatedAt) {
				t.Fatal("audit trigger did not install the distinct later database state")
			}
			read := f.request(t, http.MethodGet, "")
			var current requestNoteAppResponse
			if read.Code != http.StatusOK || json.Unmarshal(read.Body.Bytes(), &current) != nil || !reflect.DeepEqual(current.RequestNote, stored) || !current.Exists || current.RedactedFields == nil || len(current.RedactedFields) != 0 {
				t.Fatal("later GET must independently return the newer stored state")
			}
			events, err := f.db.ListAdminAudit(t.Context(), 10)
			if err != nil || len(events) != 1 || events[0].Action != "request_note.upsert" || events[0].AdminID != committed.CreatedBy || events[0].BeforeValue != "" {
				t.Fatal("committed save must retain the existing single pseudonymous audit")
			}
			var payload map[string]any
			if json.Unmarshal([]byte(events[0].AfterValue), &payload) != nil || len(payload) != 2 || payload["id"] != f.seed.RequestID || payload["tag_count"] != float64(2) {
				t.Fatal("audit must contain only own committed ID/tag count, never raw fields or the later count")
			}
		})
	}
}

func TestRequestNoteStorageAuditFailureDoesNotUndoCommittedSuccess(t *testing.T) {
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			f := newNoteStorageFailureFixture(t, false)
			f.execDialect(t, []string{
				`CREATE TRIGGER note_audit_fault BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(FAIL, 'synthetic-private-storage-detail'); END`,
			}, []string{
				`ALTER TABLE admin_audit_logs ADD CONSTRAINT synthetic_private_storage_detail CHECK (action NOT IN ('request_note.upsert', 'request_note.delete'))`,
			})
			response := f.request(t, method, `{"preserve_fields":["tags"],"note":"replacement"}`)
			if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "synthetic-private-storage-detail") {
				t.Fatal("best-effort audit failure must not turn a committed write into a retryable error")
			}
			stored, found, err := f.db.GetRequestNote(t.Context(), f.seed.RequestID)
			if err != nil || (method == http.MethodDelete && found) ||
				(method == http.MethodPatch && (!found || stored.Note != "replacement" || !reflect.DeepEqual(stored.Tags, f.seed.Tags))) {
				t.Fatal("audit failure changed the independently committed mutation")
			}
			if method == http.MethodPatch {
				var got requestNoteAppResponse
				if json.Unmarshal(response.Body.Bytes(), &got) != nil || !got.Exists || !reflect.DeepEqual(got.RequestNote, stored) {
					t.Fatal("audit failure lost the actual committed response")
				}
			}
			f.assertNoAudit(t)
		})
	}
}

type noteStorageFailureFixture struct {
	db     *store.SQLStore
	raw    *sql.DB
	server *Server
	token  string
	seed   store.RequestNote
}

func newNoteStorageFailureFixture(t *testing.T, rawReader bool) *noteStorageFailureFixture {
	t.Helper()
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-note-storage-session-secret"
	role := "note_operator"
	if rawReader {
		role = "super_admin"
	}
	now := time.Now().UTC()
	f := &noteStorageFailureFixture{db: db, raw: raw, server: s,
		token: issueLLMScopedTestToken(t, db, s, "note-storage-operator", role, "", []string{"admin:read", "admin:write"}, now),
		seed:  store.RequestNote{RequestID: "note-storage-request", Tags: []string{"original-tag"}, Note: "original-note", CreatedBy: "original-editor", UpdatedAt: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: f.seed.RequestID, Method: http.MethodPost, Endpoint: "/v1/chat/completions", StatusCode: http.StatusOK, CreatedAt: now,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRequestNote(t.Context(), f.seed); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *noteStorageFailureFixture) request(t *testing.T, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "/admin/requests/"+f.seed.RequestID+"/note", strings.NewReader(body)).WithContext(t.Context())
	r.Header.Set("X-Vibe-UI", "app")
	r.Header.Set("Authorization", "Bearer "+f.token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.server.handleRequestNote(w, r)
	return w
}

func (f *noteStorageFailureFixture) exec(t *testing.T, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := f.raw.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *noteStorageFailureFixture) execDialect(t *testing.T, sqlite, postgres []string) {
	t.Helper()
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		f.exec(t, postgres...)
	} else {
		f.exec(t, sqlite...)
	}
}

func (f *noteStorageFailureFixture) assertOriginal(t *testing.T) {
	t.Helper()
	after, found, err := f.db.GetRequestNote(t.Context(), f.seed.RequestID)
	if err != nil || !found || !reflect.DeepEqual(after, f.seed) {
		t.Fatal("failed note operation changed original fields or metadata")
	}
}

func (f *noteStorageFailureFixture) assertNoAudit(t *testing.T) {
	t.Helper()
	events, err := f.db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(events) != 0 {
		t.Fatal("failed operation must not leave a committed admin audit")
	}
}

func assertNoteStorageError(t *testing.T, w *httptest.ResponseRecorder, code, message string) {
	t.Helper()
	var got map[string]any
	want := map[string]any{"error": map[string]any{"code": code, "type": "server_error", "message": message, "param": nil}}
	if w.Code != http.StatusInternalServerError || json.Unmarshal(w.Body.Bytes(), &got) != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("storage fault must return only its stable safe error, not an empty/success DTO (status %d)", w.Code)
	}
}
