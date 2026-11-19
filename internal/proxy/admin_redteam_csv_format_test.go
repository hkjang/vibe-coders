package proxy

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

const probeCSVPublicHeader = "pack_id,pack_name,category,pack_severity,requires_approval,case_id,case_key,expected_policy,evaluator_type,severity,target_types,risk_tags,input_template,vibe_probe_csv_format"

func probeCSVPublicRow(id, prompt string) []string {
	return []string{"public-format-pack", "공개 합성 팩", "custom", "low", "false", id, id, "refuse", "rule", "low", "provider|model", "ko|public", prompt, "probe-v1"}
}

func probeCSVRecordsBody(t *testing.T, records [][]string) string {
	t.Helper()
	var body bytes.Buffer
	body.WriteString("\ufeff")
	writer := csv.NewWriter(&body)
	writer.WriteAll(records)
	if err := writer.Error(); err != nil {
		t.Fatal(err)
	}
	return body.String()
}

func probeCSVImportResponse(server *Server, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/admin/redteam/probe-packs/import", strings.NewReader(body))
	request.Header.Set("Content-Type", "text/csv; charset=utf-8")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	return response
}

func TestRedTeamProbeCSVVersionedRoundTrip(t *testing.T) {
	server, db, _ := newRedTeamTestServer(t)
	prompts := []string{
		"plain readable prompt", "'literal apostrophe", "''two apostrophes", "'=literal apostrophe before formula",
		"=1+1", "+1+1", "-1+1", "@SUM(1)", " \t=1+1", "\ufeff=1+1", "\x01=1+1", "\x7f@SUM(1)",
		"  leading and trailing spaces  ", "\tleading tab", "\nleading newline", "a\r\nb\rc\nd",
		"한글, 日本語, emoji 😀", "a,\"quoted\",cell", "vibe-text-v1:\"literal marker\"",
		"vibe-list-v1:[\"literal prompt\"]", "trailing tab\t", "line one\nline two",
	}
	pack := store.RedTeamProbePack{ID: "public-format-pack", Name: "  '=공개 합성 팩\r\n  ", Category: "custom", Severity: "low", Version: "v1", Enabled: true}
	cases := make([]store.RedTeamProbeCase, len(prompts))
	for i, prompt := range prompts {
		cases[i] = store.RedTeamProbeCase{ID: fmt.Sprintf("public-format-%02d", i), PackID: pack.ID, CaseKey: fmt.Sprintf("probe-%02d", i), InputTemplate: prompt, ExpectedPolicy: "refuse", EvaluatorType: "rule", Severity: "low", TargetTypes: []string{"provider", "model"}, RiskTags: []string{"literal|pipe", " leading ", "", "vibe-list-v1:literal", "=label", "한글"}}
	}
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, cases); err != nil {
		t.Fatal(err)
	}
	exported := httptest.NewRecorder()
	server.Routes().ServeHTTP(exported, httptest.NewRequest(http.MethodGet, "/admin/redteam/probe-packs/export?format=csv", nil))
	if exported.Code != http.StatusOK {
		t.Fatalf("export status=%d", exported.Code)
	}
	if !bytes.HasPrefix(exported.Body.Bytes(), []byte{0xef, 0xbb, 0xbf}) {
		t.Fatal("missing UTF-8 BOM")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(exported.Body.String(), "\ufeff")))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(records[0], ",") != probeCSVPublicHeader {
		t.Fatalf("unexpected header %v", records[0])
	}
	found := 0
	for _, row := range records[1:] {
		for _, cell := range row {
			if csvTextCell(cell) != cell {
				t.Fatal("export left an active spreadsheet formula prefix")
			}
		}
		if row[0] == pack.ID {
			found++
			if row[13] != "probe-v1" {
				t.Fatal("missing format marker")
			}
			if row[5] == cases[0].ID && row[12] != prompts[0] {
				t.Fatal("ordinary prompt is no longer directly editable")
			}
			if row[5] == cases[1].ID && !strings.HasPrefix(row[12], "vibe-text-v1:") {
				t.Fatal("literal apostrophe was not represented explicitly")
			}
		}
	}
	if found != len(prompts) {
		t.Fatalf("exported %d custom rows", found)
	}
	// Change the stored values first, so a no-op import cannot satisfy the round trip.
	changed := cases[0]
	changed.InputTemplate = "replace this sentinel"
	if err := db.UpsertRedTeamProbeCase(t.Context(), changed); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := probeCSVImportResponse(server, exported.Body.String())
		if response.Code != http.StatusOK {
			t.Fatalf("import status=%d body=%s", response.Code, response.Body.String())
		}
		stored, err := db.RedTeamProbeCases(t.Context(), []string{pack.ID})
		if err != nil {
			t.Fatal(err)
		}
		if len(stored) != len(cases) {
			t.Fatalf("case count=%d want=%d", len(stored), len(cases))
		}
		byID := map[string]store.RedTeamProbeCase{}
		for _, c := range stored {
			byID[c.ID] = c
		}
		for _, expected := range cases {
			actual := byID[expected.ID]
			if actual.InputTemplate != expected.InputTemplate || actual.CaseKey != expected.CaseKey || !reflect.DeepEqual(actual.RiskTags, expected.RiskTags) || !reflect.DeepEqual(actual.TargetTypes, expected.TargetTypes) {
				t.Fatalf("round-trip changed CSV data for %s: prompt=%q tags=%#v", expected.ID, actual.InputTemplate, actual.RiskTags)
			}
		}
		packs, err := db.ListRedTeamProbePacks(t.Context(), false)
		if err != nil {
			t.Fatal(err)
		}
		for _, actual := range packs {
			if actual.ID == pack.ID && actual.Name != pack.Name {
				t.Fatalf("pack name changed: %q", actual.Name)
			}
		}
	}
}

func TestRedTeamProbeCSVVersionedEditedCells(t *testing.T) {
	server, db, _ := newRedTeamTestServer(t)
	edits := []struct{ cell, want string }{
		{"  새로 편집한 한글, prompt  ", "  새로 편집한 한글, prompt  "},
		{"'literal user edit", "'literal user edit"},
		{"'=literal edited apostrophe", "'=literal edited apostrophe"},
		{`vibe-text-v1:"=edited\r\nformula-looking text"`, "=edited\r\nformula-looking text"},
		{`vibe-text-v1:"vibe-text-v1:literal"`, "vibe-text-v1:literal"},
	}
	for i, edit := range edits {
		row := probeCSVPublicRow("public-edited-case", edit.cell)
		row[6] = "  normalized-case-key  "
		row[11] = `vibe-list-v1:["literal|pipe",""," leading "]`
		body := probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), row})
		response := probeCSVImportResponse(server, body)
		if response.Code != http.StatusOK {
			t.Fatalf("edit %d status=%d body=%s", i, response.Code, response.Body.String())
		}
		cases, err := db.RedTeamProbeCases(t.Context(), []string{row[0]})
		if err != nil {
			t.Fatal(err)
		}
		if len(cases) != 1 || cases[0].InputTemplate != edit.want || cases[0].CaseKey != "normalized-case-key" || !reflect.DeepEqual(cases[0].RiskTags, []string{"literal|pipe", "", " leading "}) {
			t.Fatalf("edit %d did not preserve data: %#v", i, cases)
		}
	}
}

func TestRedTeamProbeCSVLegacyLiteralAndSkippedRows(t *testing.T) {
	server, db, _ := newRedTeamTestServer(t)
	records := [][]string{
		{"pack_id", "pack_name", "case_id", "case_key", "input_template"},
		{" public-legacy ", "  legacy name  ", "first", " first ", "  '=literal apostrophe  "},
		{" public-legacy ", "  legacy name  ", "second", " second ", `  vibe-text-v1:"=legacy marker is literal"  `},
		{"public-legacy", "legacy name", "skipped", "missing", "   "},
	}
	response := probeCSVImportResponse(server, probeCSVRecordsBody(t, records))
	if response.Code != http.StatusOK {
		t.Fatalf("legacy status=%d", response.Code)
	}
	var result struct {
		Imported int      `json:"imported_cases"`
		Skipped  []string `json:"skipped"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Imported != 2 || len(result.Skipped) != 1 {
		t.Fatalf("legacy skipped behavior changed: %#v", result)
	}
	stored, err := db.RedTeamProbeCases(t.Context(), []string{"public-legacy"})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]string{}
	for _, c := range stored {
		byID[c.ID] = c.InputTemplate
	}
	if byID["first"] != "'=literal apostrophe" || byID["second"] != `vibe-text-v1:"=legacy marker is literal"` {
		t.Fatalf("legacy values changed: %#v", byID)
	}
}

func TestRedTeamProbeCSVInvalidMarkedFormatBeforeWrites(t *testing.T) {
	scenarios := []string{"unknown-version", "blank-version", "missing-column", "duplicate-column", "short-row", "long-row", "invalid-string", "null-string", "invalid-list", "null-list-item", "invalid-utf8", "encoded-nul", "plain-nul", "list-nul"}
	for _, scenario := range scenarios {
		t.Run(scenario, func(t *testing.T) {
			server, db, _ := newRedTeamTestServer(t)
			pack := store.RedTeamProbePack{ID: "public-format-pack", Name: "preserve pack", Severity: "low", Enabled: true}
			original := store.RedTeamProbeCase{ID: "public-original", PackID: pack.ID, CaseKey: "public-original", InputTemplate: "preserve prompt", Severity: "low"}
			if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, []store.RedTeamProbeCase{original}); err != nil {
				t.Fatal(err)
			}
			header := strings.Split(probeCSVPublicHeader, ",")
			first := probeCSVPublicRow(original.ID, "must not overwrite")
			bad := probeCSVPublicRow("public-invalid", "invalid row after a valid row")
			switch scenario {
			case "unknown-version":
				bad[13] = "probe-v2"
			case "blank-version":
				bad[13] = ""
			case "missing-column":
				header[1] = "misspelled_pack_name"
			case "duplicate-column":
				header[1] = "pack_id"
			case "short-row":
				bad = bad[:13]
			case "long-row":
				bad = append(bad, "unexpected")
			case "invalid-string":
				bad[12] = `vibe-text-v1:"unterminated`
			case "null-string":
				bad[12] = "vibe-text-v1:null"
			case "invalid-list":
				bad[11] = "vibe-list-v1:null"
			case "null-list-item":
				bad[11] = "vibe-list-v1:[null]"
			case "invalid-utf8":
				bad[12] = string([]byte{0xff})
			case "encoded-nul":
				bad[12] = `vibe-text-v1:"before\u0000after"`
			case "plain-nul":
				bad[12] = "before\x00after"
			case "list-nul":
				bad[11] = `vibe-list-v1:["before\u0000after"]`
			}
			response := probeCSVImportResponse(server, probeCSVRecordsBody(t, [][]string{header, first, bad}))
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid_csv_format") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			cases, err := db.RedTeamProbeCases(t.Context(), []string{pack.ID})
			if err != nil {
				t.Fatal(err)
			}
			if len(cases) != 1 || cases[0].InputTemplate != original.InputTemplate {
				t.Fatal("invalid marked file wrote cases")
			}
			packs, err := db.ListRedTeamProbePacks(t.Context(), false)
			if err != nil {
				t.Fatal(err)
			}
			for _, actual := range packs {
				if actual.ID == pack.ID && actual.Name != pack.Name {
					t.Fatal("invalid marked file wrote pack")
				}
			}
		})
	}
}
