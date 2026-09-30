package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// A writer need not be a raw-prompt reader. Preserve intent must never round
// trip a redacted display value or guess which of two identical masks it meant.
func TestRequestNoteContractPreservesUnseenFields(t *testing.T) {
	for _, field := range []string{"note", "tags"} {
		t.Run(field, func(t *testing.T) {
			f := newRequestNoteContractFixture(t)
			f.seed(t, []string{"first@synthetic.example", "second@synthetic.example"}, "문의 private@synthetic.example")
			before, _ := f.stored(t)
			view := f.read(t, f.writer)
			if view.Note == before.Note || reflect.DeepEqual(view.Tags, before.Tags) || len(view.Tags) != 2 || view.Tags[0] != view.Tags[1] {
				t.Fatal("fixture must exercise masked note and two distinct tags with the same projection")
			}
			body := `{"preserve_fields":["note"],"tags":["#한글 ","한글","두,단어"]}`
			if field == "tags" {
				body = `{"preserve_fields":["tags"],"note":"  수정한 평문  "}`
			}
			f.request(t, http.MethodPut, f.path, f.writer, body, http.StatusOK)
			after, found := f.stored(t)
			if !found || (field == "note" && (after.Note != before.Note || !slices.Equal(after.Tags, []string{"한글", "두 단어"}))) ||
				(field == "tags" && (!slices.Equal(after.Tags, before.Tags) || after.Note != "수정한 평문")) {
				t.Fatal("preserve intent must retain the current original field and apply only the other replacement")
			}
			if after.CreatedBy != "admin_"+hashProxyKey(f.writer)[:12] || after.UpdatedAt.IsZero() {
				t.Fatal("committed note must retain the existing pseudonymous editor metadata")
			}
			public := f.read(t, f.writer)
			if public.Exists == nil || !*public.Exists || !slices.Contains(public.RedactedFields, field) {
				t.Fatal("app response must confirm existence and which field remains projected")
			}
		})
	}
}

func TestRequestNoteContractConfirmedExistenceAndTimestamp(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	missing := f.read(t, f.adminToken)
	if missing.Exists == nil || *missing.Exists || missing.RedactedFields == nil || missing.Tags == nil || missing.RequestID != f.id {
		t.Fatal("missing row must be confirmed separately from an empty saved row")
	}
	data := f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"preserve_fields":[],"tags":[],"note":""}`, http.StatusOK)
	var saved requestNoteContractResponse
	if json.Unmarshal(data, &saved) != nil || saved.Exists == nil || !*saved.Exists || saved.UpdatedAt.IsZero() {
		t.Fatal("app save response must contain its actual committed existence and update time")
	}
	stored, found := f.stored(t)
	if !found || !saved.UpdatedAt.Equal(stored.UpdatedAt) || stored.Note != "" || len(stored.Tags) != 0 {
		t.Fatal("confirmed app response must match its committed empty row")
	}
	f.request(t, http.MethodDelete, f.path, f.adminToken, "", http.StatusOK)
	if _, found := f.stored(t); found {
		t.Fatal("explicit deletion must also remove an empty saved row")
	}
}

func TestRequestNoteContractRejectsAmbiguousPreserveWithoutWrites(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	f.seed(t, []string{"keep-tag"}, "keep-note")
	before, _ := f.stored(t)
	beforeAudit := f.auditCount(t)
	for _, body := range []string{
		`{"preserve_fields":null}`, `{"preserve_fields":"note"}`, `{"preserve_fields":[1]}`,
		`{"preserve_fields":["unknown"]}`, `{"preserve_fields":["note","note"]}`,
		`{"preserve_fields":["tags","tags"]}`, `{"preserve_fields":["Note"]}`,
		`{"preserve_fields":["note"],"note":null}`, `{"preserve_fields":["note"],"note":""}`,
		`{"preserve_fields":["tags"],"tags":null}`, `{"preserve_fields":["tags"],"tags":[]}`,
	} {
		f.request(t, http.MethodPut, f.path, f.writer, body, http.StatusBadRequest)
		stored, _ := f.stored(t)
		if !reflect.DeepEqual(before, stored) || f.auditCount(t) != beforeAudit {
			t.Fatal("invalid preserve intent must not write either field, metadata or audit")
		}
	}
}

func TestRequestNoteContractLegacyReplacementAndClearRemainUnchanged(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		for _, body := range []string{`{}`, `null`, `{"tags":null,"note":null}`, `{"tags":[],"note":""}`, `{"preserve_fields":["note","tags"]}`} {
			f.seed(t, []string{"old"}, "old")
			f.legacy(t, method, body)
			stored, found := f.stored(t)
			if !found || stored.Note != "" || len(stored.Tags) != 0 {
				t.Fatal("legacy omitted/null fields still replace with empty values, including unknown preserve intent")
			}
		}
	}
	f.seed(t, []string{"old"}, "old")
	f.request(t, http.MethodPut, f.path, f.adminToken, `{"preserve_fields":[],"note":"new"}`, http.StatusOK)
	stored, _ := f.stored(t)
	if stored.Note != "new" || len(stored.Tags) != 0 {
		t.Fatal("unpreserved omitted app field must retain existing replacement semantics")
	}
}

func TestRequestNoteContractWritePermissionAndSafeAudit(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	f.seed(t, []string{"note@synthetic.example"}, "private@synthetic.example")
	reader := issueLLMScopedTestToken(t, f.db, f.server, "note-reader", "readonly_admin", "", []string{"admin:read"}, time.Now().UTC())
	f.read(t, reader)
	before, _ := f.stored(t)
	beforeAudit := f.auditCount(t)
	for _, token := range []string{reader, ""} {
		for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodDelete} {
			f.request(t, method, f.path, token, `{"preserve_fields":[],"note":"changed"}`, http.StatusUnauthorized)
		}
	}
	stored, _ := f.stored(t)
	if !reflect.DeepEqual(before, stored) || f.auditCount(t) != beforeAudit {
		t.Fatal("write rejection must preserve the row, metadata and audit")
	}
	f.request(t, http.MethodPut, f.path, f.writer, `{"preserve_fields":["note","tags"]}`, http.StatusOK)
	events, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil || !slices.ContainsFunc(events, func(event store.AdminAuditPublic) bool {
		var after struct {
			ID       string `json:"id"`
			TagCount int    `json:"tag_count"`
		}
		return event.Action == "request_note.upsert" && event.AdminID == "admin_"+hashProxyKey(f.writer)[:12] &&
			event.BeforeValue == "" && json.Unmarshal([]byte(event.AfterValue), &after) == nil && after.ID == f.id && after.TagCount == 1 &&
			!strings.Contains(event.AfterValue, "synthetic.example")
	}) {
		t.Fatal("app save audit must retain the existing pseudonymous actor and safe ID/tag-count payload")
	}
}

func TestRequestNoteContractPreserveUsesCurrentDatabaseValue(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	f.seed(t, []string{"first@synthetic.example"}, "old@synthetic.example")
	f.read(t, f.writer) // The browser's masked baseline is now stale.
	f.seed(t, []string{"second@synthetic.example"}, "newer@synthetic.example")
	f.request(t, http.MethodPut, f.path, f.writer,
		`{"preserve_fields":["note"],"tags":["replacement"]}`, http.StatusOK)
	stored, found := f.stored(t)
	if !found || stored.Note != "newer@synthetic.example" || !slices.Equal(stored.Tags, []string{"replacement"}) {
		t.Fatal("preserve must use the current database column, not the earlier visible baseline")
	}
}

func TestRequestNoteContractTeamScopeAppliesToReadsAndPreservedWrites(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	for _, team := range []store.AuthTeam{{ID: "note-team-id", Name: "note-team-name"}, {ID: "other-team-id", Name: "other-team-name"}} {
		if err := f.db.UpsertAuthTeam(t.Context(), team); err != nil {
			t.Fatal("team scope fixture failed")
		}
	}
	if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "note-team-key", Name: "synthetic", KeyHash: "synthetic-note-team-hash", Team: "note-team-name", Status: "active",
	}); err != nil {
		t.Fatal("key team fixture failed")
	}
	f.id = "note-team-request"
	f.path = "/admin/requests/" + f.id + "/note"
	if err := f.db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: f.id, APIKeyID: "note-team-key", Method: http.MethodPost, Endpoint: "/v1/chat/completions", Model: "test-model", Provider: "test", StatusCode: http.StatusOK, CreatedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal("scoped request fixture failed")
	}
	f.seed(t, []string{"scoped"}, "scoped note")
	before, _ := f.stored(t)
	beforeAudit := f.auditCount(t)
	for index, teamID := range []string{"other-team-id", "", " note-team-id ", "missing-team"} {
		token := issueLLMScopedTestToken(t, f.db, f.server, "rejected-note-team-"+string(rune('a'+index)), "team_admin", teamID, []string{"admin:read", "admin:write"}, time.Now().UTC())
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete} {
			f.request(t, method, f.path, token, `{"preserve_fields":["note","tags"]}`, http.StatusForbidden)
		}
	}
	after, _ := f.stored(t)
	if !reflect.DeepEqual(before, after) || f.auditCount(t) != beforeAudit {
		t.Fatal("cross-team rejection changed note fields, metadata or audit")
	}
	allowed := issueLLMScopedTestToken(t, f.db, f.server, "allowed-note-team", "team_admin", "note-team-id", []string{"admin:read", "admin:write"}, time.Now().UTC())
	f.read(t, allowed)
	f.request(t, http.MethodPut, f.path, allowed, `{"preserve_fields":["tags"],"note":"team replacement"}`, http.StatusOK)
	after, _ = f.stored(t)
	if after.Note != "team replacement" || !slices.Equal(after.Tags, before.Tags) {
		t.Fatal("canonical team ID must retain access to a key using that team's legacy display name")
	}
}

func TestRequestNoteContractOrphanNoteDoesNotBypassRequestLookup(t *testing.T) {
	f := newRequestNoteContractFixture(t)
	f.id, f.path = "absent-note-request", "/admin/requests/absent-note-request/note"
	f.seed(t, []string{"retained"}, "retained note")
	before, _ := f.stored(t)
	beforeAudit := f.auditCount(t)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete} {
		f.request(t, method, f.path, f.adminToken, `{"preserve_fields":[],"note":"replacement"}`, http.StatusNotFound)
	}
	after, _ := f.stored(t)
	if !reflect.DeepEqual(before, after) || f.auditCount(t) != beforeAudit {
		t.Fatal("an orphan note must not bypass the existing request lookup contract")
	}
}

type requestNoteContractResponse struct {
	store.RequestNote
	Exists         *bool    `json:"exists"`
	RedactedFields []string `json:"redacted_fields"`
}

type requestNoteContractFixture struct {
	*apiKeyScopeContractFixture // Real authenticated transport only.
	server                      *Server
	id, path, writer            string
}

func newRequestNoteContractFixture(t *testing.T) *requestNoteContractFixture {
	t.Helper()
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if hits.Load() != 0 {
			t.Error("note management must not call the model upstream")
		}
	})
	f := &requestNoteContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}, id: "note-contract-request"}
	f.path = "/admin/requests/" + f.id + "/note"
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	now := time.Now().UTC()
	f.adminToken = issueLLMScopedTestToken(t, f.db, f.server, "note-root", "super_admin", "", []string{"admin:read", "admin:write"}, now)
	f.writer = issueLLMScopedTestToken(t, f.db, f.server, "note-writer", "note_operator", "", []string{"admin:read", "admin:write"}, now)
	if err := f.db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: f.id, Method: http.MethodPost, Endpoint: "/v1/chat/completions", Model: "test-model", Provider: "test", StatusCode: http.StatusOK, CreatedAt: now,
	}}); err != nil {
		t.Fatal("request note fixture seed failed")
	}
	return f
}

func (f *requestNoteContractFixture) seed(t *testing.T, tags []string, note string) {
	t.Helper()
	if err := f.db.UpsertRequestNote(t.Context(), store.RequestNote{
		RequestID: f.id, Tags: tags, Note: note, CreatedBy: "synthetic-editor", UpdatedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatal("note seed failed")
	}
}

func (f *requestNoteContractFixture) stored(t *testing.T) (store.RequestNote, bool) {
	t.Helper()
	note, found, err := f.db.GetRequestNote(t.Context(), f.id)
	if err != nil {
		t.Fatal("stored note lookup failed")
	}
	return note, found
}

func (f *requestNoteContractFixture) read(t *testing.T, token string) requestNoteContractResponse {
	t.Helper()
	data := f.request(t, http.MethodGet, f.path, token, "", http.StatusOK)
	if token == f.writer && (strings.Contains(string(data), "private@synthetic.example") || strings.Contains(string(data), "first@synthetic.example")) {
		t.Fatal("limited reader response exposed an original field")
	}
	var value requestNoteContractResponse
	if json.Unmarshal(data, &value) != nil {
		t.Fatal("note response must be JSON")
	}
	return value
}

func (f *requestNoteContractFixture) auditCount(t *testing.T) int {
	t.Helper()
	events, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal("note audit lookup failed")
	}
	return len(events)
}

func (f *requestNoteContractFixture) request(t *testing.T, method, path, token, body string, wantStatus int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal("app note request creation failed")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vibe-UI", "app")
	response, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal("app note request failed")
	}
	defer response.Body.Close()
	// The existing parent dispatcher rejects unauthorized callers before the
	// note handler. That shared 401 has no app/legacy response variant.
	if response.StatusCode != http.StatusUnauthorized {
		assertRequestNoteVariantHeaders(t, response.Header)
	}
	if response.StatusCode != wantStatus {
		t.Fatalf("%s note returned %d, want %d", method, response.StatusCode, wantStatus)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("app note response failed")
	}
	return data
}

func assertRequestNoteVariantHeaders(t *testing.T, header http.Header) {
	t.Helper()
	vary := strings.Split(strings.Join(header.Values("Vary"), ","), ",")
	if header.Get("Cache-Control") != "no-store" || !slices.ContainsFunc(vary, func(value string) bool {
		return strings.EqualFold(strings.TrimSpace(value), "X-Vibe-UI")
	}) {
		t.Fatal("note projection metadata must vary by app header and never be cached")
	}
}

func (f *requestNoteContractFixture) legacy(t *testing.T, method, body string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+f.path, strings.NewReader(body))
	if err != nil {
		t.Fatal("legacy note request creation failed")
	}
	req.Header.Set("Authorization", "Bearer "+f.adminToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal("legacy note request failed")
	}
	defer response.Body.Close()
	assertRequestNoteVariantHeaders(t, response.Header)
	if response.StatusCode != http.StatusOK {
		t.Fatal("legacy note replacement unexpectedly failed")
	}
	data, err := io.ReadAll(response.Body)
	var value map[string]json.RawMessage
	if err != nil || json.Unmarshal(data, &value) != nil {
		t.Fatal("legacy response must be JSON")
	}
	if _, exists := value["exists"]; exists {
		t.Fatal("app projection metadata must not silently change the legacy response")
	}
}
