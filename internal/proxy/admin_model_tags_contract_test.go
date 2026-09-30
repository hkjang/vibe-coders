package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// These pin existing authenticated Routes and committed model-tag semantics.
// The shared fixture uses isolated SQLite by default; TEST_POSTGRES_DSN opts
// into the existing per-test PostgreSQL schema helper. Its only configured
// upstream is loopback and the fixture asserts zero upstream requests.
func TestModelTagContractUpsertIdentityFieldsAndServerMetadata(t *testing.T) {
	f := newModelTagContractFixture(t)
	first := f.save(t, f.adminToken, map[string]any{
		"model": " \tpublic-model-a\u0085 ", "good_for": " sql, code ",
		"avoid_for": " image ", "risk_note": " public note ",
		"updated_by": "forged-actor", "updated_at": "2001-01-01T00:00:00Z",
	})
	if first.Model != "public-model-a" || first.GoodFor != " sql, code " || first.AvoidFor != " image " || first.RiskNote != " public note " {
		t.Fatal("only model is trimmed; tag text is stored without extra normalization")
	}
	if first.UpdatedBy != "governance-writer" || first.UpdatedAt == "2001-01-01T00:00:00Z" {
		t.Fatal("the authenticated subject and server timestamp must replace supplied metadata")
	}
	assertModelGovernanceTimestamp(t, first.UpdatedAt)

	revised := f.save(t, f.otherWriter, map[string]any{"model": first.Model, "good_for": "revised"})
	if revised.Model != first.Model || revised.GoodFor != "revised" || revised.AvoidFor != "" || revised.RiskNote != "" || revised.UpdatedBy != "governance-other" || len(f.rows(t)) != 1 {
		t.Fatal("same-ID POST replaces the whole tag row, clears omitted fields and updates its actor")
	}
	// A different model is an additional upsert target, never a rename of A.
	second := f.save(t, f.adminToken, map[string]any{"model": "public-model-b", "good_for": "second"})
	if len(f.rows(t)) != 2 || f.row(t, first.Model) != revised || f.row(t, second.Model) != second {
		t.Fatal("posting another model must leave the original row unchanged")
	}
	if got := f.list(t, f.reader); !reflect.DeepEqual(got, f.rows(t)) {
		t.Fatal("authenticated list must match the committed rows")
	}
	if events := f.audits(t); len(events) != 3 {
		t.Fatal("each accepted upsert must retain its existing admin audit")
	} else {
		for _, event := range events {
			var detail map[string]string
			if event.Action != "model_tag.upsert" || (event.BeforeValue != first.Model && event.BeforeValue != second.Model) || json.Unmarshal([]byte(event.AfterValue), &detail) != nil || len(detail) != 2 {
				t.Fatal("upsert audit must identify its model and contain only the two task-guidance fields")
			}
			if _, ok := detail["good_for"]; !ok {
				t.Fatal("audit omitted good_for")
			}
			if _, ok := detail["avoid_for"]; !ok {
				t.Fatal("audit omitted avoid_for")
			}
			if event.AdminID != "admin_"+hashProxyKey(f.adminToken)[:12] && event.AdminID != "admin_"+hashProxyKey(f.otherWriter)[:12] {
				t.Fatal("audit identity must retain the existing hashed-token convention, separate from row authorship")
			}
		}
	}
}

func TestModelTagContractOptionalNullAndInvalidInputs(t *testing.T) {
	f := newModelTagContractFixture(t)
	for _, scenario := range []struct {
		name string
		body map[string]any
	}{
		{"omitted", map[string]any{"model": "optional-model"}},
		{"null", map[string]any{"model": "optional-model", "good_for": nil, "avoid_for": nil, "risk_note": nil, "updated_by": nil, "updated_at": nil}},
		{"empty", map[string]any{"model": "optional-model", "good_for": "", "avoid_for": "", "risk_note": ""}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f.save(t, f.adminToken, map[string]any{"model": "optional-model", "good_for": "sql", "avoid_for": "image", "risk_note": "public note"})
			got := f.save(t, f.otherWriter, scenario.body)
			if got.GoodFor != "" || got.AvoidFor != "" || got.RiskNote != "" || got.UpdatedBy != "governance-other" || len(f.rows(t)) != 1 {
				t.Fatal("omitted, null and empty optional strings must all replace prior values with empty strings")
			}
		})
	}
	before, audits := f.rows(t), f.audits(t)
	for _, body := range []string{
		`{}`, `{"model":null}`, `{"model":" \t\u0085 "}`, `{"model":1}`,
		`{"model":"optional-model","good_for":[]}`, `{"model":"optional-model","avoid_for":false}`,
		`{"model":"optional-model","risk_note":{}}`, `{"model":`,
	} {
		f.request(t, http.MethodPost, "/admin/model-tags", f.adminToken, body, http.StatusBadRequest)
	}
	if !reflect.DeepEqual(before, f.rows(t)) || !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("invalid bodies must not partially overwrite rows or add successful mutation audits")
	}
}

func TestModelTagContractFEFFAndNELIdentifyDifferentUIRisks(t *testing.T) {
	f := newModelTagContractFixture(t)
	const plain, feff, nel = "unicode-model", "\ufeffunicode-model", "\u0085unicode-model"
	regular := f.save(t, f.adminToken, map[string]any{"model": plain, "good_for": "plain control"})
	opaque := f.save(t, f.adminToken, map[string]any{"model": feff, "good_for": "opaque control"})
	if opaque.Model != feff || regular.Model != plain || len(f.rows(t)) != 2 {
		t.Fatal("Go TrimSpace preserves FEFF, so FEFF-prefixed and plain models are distinct HTTP-created rows")
	}
	// This is a server target contract, not execution of JavaScript: a client that
	// has already stripped FEFF sends plain and updates that different row.
	f.save(t, f.otherWriter, map[string]any{"model": plain, "good_for": "client-stripped target"})
	if f.row(t, feff) != opaque || f.row(t, plain).GoodFor != "client-stripped target" {
		t.Fatal("the plain payload must not be interpreted as the opaque FEFF row")
	}
	// Direct seeding is explicitly an imported-row control. HTTP creation cannot
	// retain leading NEL because Go trims it, unlike JavaScript String.trim.
	imported := store.ModelUsageTag{Model: nel, GoodFor: "imported control", UpdatedBy: "public-importer"}
	if err := f.db.UpsertModelUsageTag(t.Context(), &imported); err != nil {
		t.Fatal(err)
	}
	got := f.save(t, f.adminToken, map[string]any{"model": nel, "good_for": "Go-trimmed target"})
	if got.Model != plain || f.row(t, nel) != imported || f.row(t, feff) != opaque || len(f.rows(t)) != 3 {
		t.Fatal("an imported NEL target sent unchanged is normalized to the different plain row by POST")
	}
	before := f.audits(t)
	f.remove(t, nel)
	if len(f.rows(t)) != 2 || f.row(t, feff) != opaque || f.row(t, plain) != got || !reflect.DeepEqual(before, f.audits(t)) {
		t.Fatal("DELETE must use the exact NEL identifier without POST normalization or a new success audit")
	}
	f.remove(t, feff)
	if rows := f.rows(t); len(rows) != 1 || rows[0] != got {
		t.Fatal("exact FEFF deletion must not delete its plain-name neighbor")
	}
}

func TestModelTagContractEscapedPathsExactDeleteAndMissingSuccess(t *testing.T) {
	f := newModelTagContractFixture(t)
	models := []string{
		"vendor/model", "vendor%2Fmodel", "vendor%252Fmodel", "한글/100%",
		"vendor?query#fragment", "vendor//nested", "vendor/../nested", "/leading", "trailing/",
	}
	for _, model := range models {
		f.save(t, f.adminToken, map[string]any{"model": model, "good_for": "path control"})
	}
	audits := f.audits(t)
	for _, model := range models {
		before := f.rows(t)
		f.remove(t, model)
		after := f.rows(t)
		want := make([]store.ModelUsageTag, 0, len(before)-1)
		for _, row := range before {
			if row.Model != model {
				want = append(want, row)
			}
		}
		if !reflect.DeepEqual(after, want) {
			t.Fatal("percent-encoded path DELETE must remove only the exact decoded model, not a percent/slash neighbor")
		}
		// The legacy DELETE contract does not inspect RowsAffected.
		f.remove(t, model)
		if !reflect.DeepEqual(after, f.rows(t)) {
			t.Fatal("deleting an already absent model must remain a no-op 200")
		}
	}
	if !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("existing DELETE emits no successful admin audit, including missing targets")
	}
}

func TestModelTagContractReadWriteScopesAndDeniedState(t *testing.T) {
	f := newModelTagContractFixture(t)
	f.save(t, f.adminToken, map[string]any{"model": "protected-model", "risk_note": "public control"})
	before, audits := f.rows(t), f.audits(t)
	for _, token := range []string{"", f.scopeless} {
		f.request(t, http.MethodGet, "/admin/model-tags", token, "", http.StatusUnauthorized)
	}
	if got := f.list(t, f.reader); !reflect.DeepEqual(got, before) {
		t.Fatal("admin:read alone must retain list access without a raw-prompt capability")
	}
	for _, token := range []string{"", f.scopeless, f.reader} {
		f.request(t, http.MethodPost, "/admin/model-tags", token, `{"model":"protected-model","risk_note":"denied"}`, http.StatusUnauthorized)
		f.request(t, http.MethodDelete, "/admin/model-tags/protected-model", token, "", http.StatusUnauthorized)
	}
	if !reflect.DeepEqual(before, f.rows(t)) || !reflect.DeepEqual(audits, f.audits(t)) {
		t.Fatal("denied writes may record auth denial events but must not mutate tag rows or successful admin audits")
	}
}

type modelTagContractFixture struct {
	*modelGovernanceContractFixture
}

func newModelTagContractFixture(t *testing.T) *modelTagContractFixture {
	t.Helper()
	f := &modelTagContractFixture{newModelGovernanceContractFixture(t)}
	// Do not accidentally turn a ServeMux redirect into a successful request at
	// another target: every encoded-path assertion observes the first response.
	f.gateway.Client().CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return f
}

func (f *modelTagContractFixture) rows(t *testing.T) []store.ModelUsageTag {
	t.Helper()
	rows, err := f.db.ListModelUsageTags(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func (f *modelTagContractFixture) row(t *testing.T, model string) store.ModelUsageTag {
	t.Helper()
	for _, row := range f.rows(t) {
		if row.Model == model {
			return row
		}
	}
	t.Fatal("expected exact model tag is missing")
	return store.ModelUsageTag{}
}

func (f *modelTagContractFixture) save(t *testing.T, token string, body map[string]any) store.ModelUsageTag {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	data := f.request(t, http.MethodPost, "/admin/model-tags", token, string(encoded), http.StatusOK)
	var got store.ModelUsageTag
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &got) != nil || json.Unmarshal(data, &fields) != nil || len(fields) != 6 || got.Model == "" || got.UpdatedBy == "" {
		t.Fatal("POST must return the existing complete six-field flat model-tag row")
	}
	assertModelGovernanceTimestamp(t, got.UpdatedAt)
	if f.row(t, got.Model) != got {
		t.Fatal("POST response must match the committed model-tag row")
	}
	return got
}

func (f *modelTagContractFixture) list(t *testing.T, token string) []store.ModelUsageTag {
	t.Helper()
	var got struct {
		Tags []store.ModelUsageTag `json:"tags"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, "/admin/model-tags", token, "", http.StatusOK), &got) != nil || got.Tags == nil {
		t.Fatal("GET must return a confirmed, non-null tag list")
	}
	return got.Tags
}

func (f *modelTagContractFixture) remove(t *testing.T, model string) {
	t.Helper()
	var got map[string]string
	path := "/admin/model-tags/" + url.PathEscape(model)
	if strings.ContainsAny(path, "?#") {
		t.Fatal("test must percent-encode model delimiters, not create a query or fragment")
	}
	if json.Unmarshal(f.request(t, http.MethodDelete, path, f.adminToken, "", http.StatusOK), &got) != nil || len(got) != 1 || got["status"] != "deleted" {
		t.Fatal("DELETE must retain the existing 200 deleted acknowledgment")
	}
}
