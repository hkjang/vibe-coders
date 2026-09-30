package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestRequestNoteAppVariantHeaders(t *testing.T) {
	server := &Server{cfg: testConfig("http://127.0.0.1:1", "synthetic")}
	for _, app := range []string{"", "app"} {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete} {
			request := httptest.NewRequest(method, "/admin/requests//note", nil)
			request.Header.Set("X-Vibe-UI", app)
			recorder := httptest.NewRecorder()
			server.handleRequestNote(recorder, request)
			if recorder.Code != http.StatusBadRequest || recorder.Header().Get("Cache-Control") != "no-store" || !strings.Contains(recorder.Header().Get("Vary"), "X-Vibe-UI") {
				t.Fatal("header-dependent note response must not be shared or cached, including errors")
			}
		}
	}
}

func TestRequestNoteAppWriteDecode(t *testing.T) {
	for _, tc := range []struct {
		body string
		want requestNoteWrite
	}{
		{`{}`, requestNoteWrite{}},
		{`null`, requestNoteWrite{}},
		{`{"note":null,"tags":null}`, requestNoteWrite{}},
		{`{"preserve_fields":[]}`, requestNoteWrite{}},
		{`{"preserve_fields":["note","tags"]}`, requestNoteWrite{PreserveNote: true, PreserveTags: true}},
		{`{"preserve_fields":["note"],"tags":["한글"]}`, requestNoteWrite{PreserveNote: true, Tags: []string{"한글"}}},
		{`{"preserve_fields":["tags"],"note":" new "}`, requestNoteWrite{PreserveTags: true, Note: " new "}},
		{`{"preserve_fields":[],"note":"","tags":[]}`, requestNoteWrite{Tags: []string{}}},
	} {
		got, err := decodeRequestNoteWrite(strings.NewReader(tc.body), true)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("app payload decode mismatch: %s", tc.body)
		}
	}
	for _, body := range []string{
		`{"preserve_fields":null}`, `{"preserve_fields":"note"}`, `{"preserve_fields":true}`, `{"preserve_fields":1}`, `{"preserve_fields":{}}`,
		`{"preserve_fields":["other"]}`, `{"preserve_fields":["Note"]}`, `{"preserve_fields":[null]}`, `{"preserve_fields":[1]}`,
		`{"preserve_fields":["note","note"]}`, `{"preserve_fields":["tags","tags"]}`,
		`{"preserve_fields":["note"],"note":""}`, `{"preserve_fields":["note"],"note":null}`,
		`{"preserve_fields":["tags"],"tags":[]}`, `{"preserve_fields":["tags"],"tags":null}`,
		`{"preserve_fields":["note"],"Note":null}`, `{"preserve_fields":["tags"],"Tags":null}`,
		`{"note":1}`, `{"tags":"tag"}`, `[]`, `{"preserve_fields":`,
	} {
		if _, err := decodeRequestNoteWrite(strings.NewReader(body), true); err == nil {
			t.Fatalf("invalid app payload accepted: %s", body)
		}
	}
}

func TestRequestNoteAppWriteDoesNotChangeLegacyDecode(t *testing.T) {
	for _, extension := range []string{`null`, `"note"`, `["note","note"]`, `["unknown"]`, `true`} {
		body := `{"note":"replacement","tags":["tag"],"preserve_fields":` + extension + `}`
		got, err := decodeRequestNoteWrite(strings.NewReader(body), false)
		if err != nil || !reflect.DeepEqual(got, requestNoteWrite{Note: "replacement", Tags: []string{"tag"}}) {
			t.Fatal("legacy unknown field changed full replacement semantics")
		}
	}
	for _, body := range []string{`{}`, `null`, `{"note":null,"tags":null,"preserve_fields":["note","tags"]}`} {
		got, err := decodeRequestNoteWrite(strings.NewReader(body), false)
		if err != nil || !reflect.DeepEqual(got, requestNoteWrite{}) {
			t.Fatal("legacy omission/null must remain empty replacement")
		}
	}
}

func TestRequestNoteAppProjectionMetadataAndCollisionPreserveSnapshot(t *testing.T) {
	original := store.RequestNote{RequestID: "synthetic-request", Note: "contact first@example.com", Tags: []string{"first@example.com", "second@example.com"}, CreatedBy: "admin_synthetic"}
	before := original
	before.Tags = append([]string{}, original.Tags...)
	got := projectRequestNoteForApp(original, true, false)
	if !got.Exists || !reflect.DeepEqual(got.RedactedFields, []string{"note", "tags"}) || len(got.Tags) != 2 || got.Tags[0] != got.Tags[1] || !reflect.DeepEqual(original, before) {
		t.Fatal("projection must report actual changes without mutating or merging original tags")
	}
	encoded, err := json.Marshal(got)
	if err != nil || strings.Contains(string(encoded), "first@example.com") || strings.Contains(string(encoded), "second@example.com") {
		t.Fatal("app projection repeated synthetic raw private values")
	}
	var flat map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &flat); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"request_id", "tags", "note", "created_by", "updated_at", "exists", "redacted_fields"} {
		if _, ok := flat[key]; !ok {
			t.Fatalf("flat response missing required field %s", key)
		}
	}
	got = projectRequestNoteForApp(original, true, true)
	if !reflect.DeepEqual(got.RequestNote, original) || got.RedactedFields == nil || len(got.RedactedFields) != 0 {
		t.Fatal("raw-view projection must retain original values without marking unchanged fields")
	}
}

func TestRequestNoteAppProjectionOnlyMarksActuallyChangedEditableFields(t *testing.T) {
	for _, tc := range []struct {
		note   store.RequestNote
		exists bool
	}{
		{store.RequestNote{RequestID: "absent"}, false},
		{store.RequestNote{RequestID: "empty", Tags: []string{}}, true},
		{store.RequestNote{RequestID: "literal", Note: "[REDACTED_EMAIL]", Tags: []string{"[REDACTED_EMAIL]", "한글"}}, true},
		{store.RequestNote{RequestID: "author-only", CreatedBy: "first@example.com"}, true},
	} {
		got := projectRequestNoteForApp(tc.note, tc.exists, false)
		if got.Exists != tc.exists || got.RedactedFields == nil || len(got.RedactedFields) != 0 || got.Tags == nil {
			t.Fatal("missing/empty/literal marker or masked author incorrectly changed editable metadata")
		}
	}
}
