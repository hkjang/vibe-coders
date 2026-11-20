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

func probeMetadataPack(t *testing.T, db *store.SQLStore, id string) store.RedTeamProbePack {
	t.Helper()
	packs, err := db.ListRedTeamProbePacks(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, pack := range packs {
		if pack.ID == id {
			return pack
		}
	}
	t.Fatal("fixture pack is missing")
	return store.RedTeamProbePack{}
}

func seedProbeMetadata(t *testing.T, db *store.SQLStore) store.RedTeamProbePack {
	t.Helper()
	pack := store.RedTeamProbePack{ID: redTeamCustomPackID("public metadata pack"), Name: "public metadata pack", Category: "custom", Severity: "low", Version: "v27", Enabled: false, RequiresApproval: true, CreatedBy: "original-actor", CreatedAt: "2025-01-02T03:04:05Z"}
	cases := []store.RedTeamProbeCase{
		{ID: "public-edited", PackID: pack.ID, CaseKey: "editable", InputTemplate: "original prompt", ExpectedPolicy: "refuse", EvaluatorType: "rule", Severity: "low", Parameters: map[string]any{"temperature": 0.25, "nested": map[string]any{"limit": float64(7), "enabled": false}}, CreatedAt: "2025-01-02T04:04:05Z"},
		{ID: "public-omitted", PackID: pack.ID, CaseKey: "untouched", InputTemplate: "untouched prompt", Parameters: map[string]any{"sentinel": "preserve this"}, CreatedAt: "2025-01-02T05:04:05Z"},
	}
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, cases); err != nil {
		t.Fatal(err)
	}
	return probeMetadataPack(t, db, pack.ID)
}

func assertProbeMetadata(t *testing.T, before, after store.RedTeamProbePack, wantPrompt string) {
	t.Helper()
	if after.Enabled != before.Enabled || after.Version != before.Version || after.CreatedBy != before.CreatedBy || after.CreatedAt != before.CreatedAt {
		t.Errorf("unrepresented pack metadata changed: enabled=%v version=%q actor=%q created=%q", after.Enabled, after.Version, after.CreatedBy, after.CreatedAt)
	}
	old := map[string]store.RedTeamProbeCase{}
	for _, c := range before.Cases {
		old[c.ID] = c
	}
	found := false
	for _, c := range after.Cases {
		previous, exists := old[c.ID]
		if !exists {
			continue
		}
		if c.ID == "public-omitted" {
			if !reflect.DeepEqual(c, previous) {
				t.Error("omitted case was modified")
			}
			continue
		}
		found = true
		if c.InputTemplate != wantPrompt {
			t.Errorf("supported prompt edit was not applied: %q", c.InputTemplate)
		}
		if !reflect.DeepEqual(c.Parameters, previous.Parameters) || c.CreatedAt != previous.CreatedAt {
			t.Errorf("unrepresented case metadata changed: parameters=%#v created=%q", c.Parameters, c.CreatedAt)
		}
	}
	if !found {
		t.Error("edited case disappeared")
	}
}

func TestRedTeamProbeCSVPreservesUnrepresentedMetadata(t *testing.T) {
	for _, versioned := range []bool{false, true} {
		name := "legacy"
		if versioned {
			name = "probe-v1"
		}
		t.Run(name, func(t *testing.T) {
			server, db, _ := newRedTeamTestServer(t)
			before := seedProbeMetadata(t, db)
			header := strings.Split(probeCSVPublicHeader, ",")
			row := probeCSVPublicRow("public-edited", "edited prompt")
			row[0], row[1], row[6] = before.ID, "edited pack", "editable"
			created := probeCSVPublicRow("public-created", "created prompt")
			created[0], created[1] = "public-created-pack", "created pack"
			if !versioned {
				header = header[:13]
				row = row[:13]
				created = created[:13]
			}
			body := probeCSVRecordsBody(t, [][]string{header, row, created})
			for attempt := 0; attempt < 2; attempt++ {
				response := probeCSVImportResponse(server, body)
				if response.Code != http.StatusOK {
					t.Fatalf("import status=%d", response.Code)
				}
				after := probeMetadataPack(t, db, before.ID)
				assertProbeMetadata(t, before, after, "edited prompt")
				if after.Name != "edited pack" {
					t.Error("explicit CSV pack edits were not applied")
				}
				if len(after.Cases) != 2 {
					t.Error("CSV import duplicated or deleted an existing case")
				}
				fresh := probeMetadataPack(t, db, "public-created-pack")
				if !fresh.Enabled || fresh.Version != "v1" || len(fresh.Cases) != 1 || len(fresh.Cases[0].Parameters) != 0 {
					t.Errorf("new CSV record defaults changed: %#v", fresh)
				}
			}
		})
	}
}

func TestRedTeamProbeManualEditPreservesUnrepresentedMetadata(t *testing.T) {
	for _, selectExisting := range []bool{true, false} {
		name := "existing-pack"
		if !selectExisting {
			name = "derived-custom-pack"
		}
		t.Run(name, func(t *testing.T) {
			server, db, _ := newRedTeamTestServer(t)
			before := seedProbeMetadata(t, db)
			body := map[string]any{"case_id": "public-edited", "case_key": "editable", "input_template": "manual edit", "severity": "low", "pack_name": before.Name}
			if selectExisting {
				body["pack_id"] = before.ID
			}
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/admin/redteam/probe-cases", strings.NewReader(string(raw)))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, request)
			if response.Code != http.StatusCreated {
				t.Fatalf("manual edit status=%d", response.Code)
			}
			after := probeMetadataPack(t, db, before.ID)
			assertProbeMetadata(t, before, after, "manual edit")
			var receipt struct {
				Case store.RedTeamProbeCase `json:"case"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
				t.Fatal(err)
			}
			// This write receipt retains its existing editable-field contract. It
			// must not newly expose stored parameters through a write-only scope.
			if receipt.Case.ID != "public-edited" || receipt.Case.InputTemplate != "manual edit" || len(receipt.Case.Parameters) != 0 {
				t.Error("manual edit receipt changed its supported-field contract")
			}
		})
	}
}

func TestRedTeamProbeFullUpsertsStillReplaceMetadata(t *testing.T) {
	_, db, _ := newRedTeamTestServer(t)
	before := seedProbeMetadata(t, db)
	updated := before
	updated.Enabled = true
	updated.Version = "v28"
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), updated, nil); err != nil {
		t.Fatal(err)
	}
	var edited store.RedTeamProbeCase
	for _, c := range before.Cases {
		if c.ID == "public-edited" {
			edited = c
		}
	}
	edited.Parameters = map[string]any{"explicit replacement": true}
	if err := db.UpsertRedTeamProbeCase(t.Context(), edited); err != nil {
		t.Fatal(err)
	}
	after := probeMetadataPack(t, db, before.ID)
	if !after.Enabled || after.Version != "v28" {
		t.Error("full pack upsert lost its explicit metadata replacement contract")
	}
	for _, c := range after.Cases {
		if c.ID == edited.ID && !reflect.DeepEqual(c.Parameters, edited.Parameters) {
			t.Error("full case upsert no longer replaces parameters")
		}
	}
}

// Exercise the actual export output, including default packs, rather than only
// hand-authored edited files. Only metadata absent from CSV is compared here.
func TestRedTeamProbeCSVExportPreservesUnrepresentedMetadata(t *testing.T) {
	server, db, _ := newRedTeamTestServer(t)
	seedProbeMetadata(t, db)
	exported := httptest.NewRecorder()
	server.Routes().ServeHTTP(exported, httptest.NewRequest(http.MethodGet, "/admin/redteam/probe-packs/export?format=csv", nil))
	if exported.Code != http.StatusOK {
		t.Fatalf("export status=%d", exported.Code)
	}
	before, err := db.ListRedTeamProbePacks(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}
	packMetadata := func(packs []store.RedTeamProbePack) map[string]any {
		out := map[string]any{}
		for _, pack := range packs {
			cases := map[string]any{}
			for _, c := range pack.Cases {
				cases[c.ID] = []any{c.Parameters, c.CreatedAt}
			}
			out[pack.ID] = []any{pack.Version, pack.Enabled, pack.CreatedBy, pack.CreatedAt, cases}
		}
		return out
	}
	snapshot := packMetadata(before)
	for attempt := 0; attempt < 2; attempt++ {
		response := probeCSVImportResponse(server, exported.Body.String())
		if response.Code != http.StatusOK {
			t.Fatalf("round-trip status=%d", response.Code)
		}
		after, err := db.ListRedTeamProbePacks(t.Context(), true)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(packMetadata(after), snapshot) {
			t.Fatal("actual exported catalogue changed unrepresented metadata or created duplicate records")
		}
	}
}
