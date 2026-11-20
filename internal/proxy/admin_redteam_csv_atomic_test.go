package proxy

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func csvImportFault(t *testing.T, raw *sql.DB, stage string) func() {
	t.Helper()
	table, condition := "redteam_probe_cases", "NEW.id = 'atomic-new-case'"
	if strings.HasPrefix(stage, "pack") {
		table, condition = "redteam_probe_packs", "NEW.id = 'atomic-new-pack'"
	}
	if strings.HasPrefix(stage, "audit") {
		table, condition = "admin_audit_logs", "NEW.action = 'redteam.probe.import'"
	}
	effect := "RAISE(ABORT, 'synthetic-import-database-detail')"
	if strings.HasSuffix(stage, "ignore") {
		effect = "RAISE(IGNORE)"
	}
	statements := []string{fmt.Sprintf(`CREATE TRIGGER reject_csv_import BEFORE INSERT ON %s WHEN %s BEGIN SELECT %s; END`, table, condition, effect)}
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		action := "RAISE EXCEPTION 'synthetic-import-database-detail'"
		if strings.HasSuffix(stage, "ignore") {
			action = "RETURN NULL"
		}
		statements = []string{fmt.Sprintf(`CREATE FUNCTION reject_csv_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF %s THEN %s; END IF; RETURN NEW; END $$`, condition, action), fmt.Sprintf(`CREATE TRIGGER reject_csv_import BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION reject_csv_import()`, table)}
	}
	for _, q := range statements {
		if _, err := raw.ExecContext(t.Context(), q); err != nil {
			t.Fatal(err)
		}
	}
	return func() {
		q := "DROP TRIGGER reject_csv_import"
		if os.Getenv("TEST_POSTGRES_DSN") != "" {
			q += " ON " + table
		}
		if _, err := raw.ExecContext(t.Context(), q); err != nil {
			t.Fatal(err)
		}
		if os.Getenv("TEST_POSTGRES_DSN") != "" {
			if _, err := raw.ExecContext(t.Context(), "DROP FUNCTION reject_csv_import()"); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func csvImportAuditCount(t *testing.T, raw *sql.DB) int {
	t.Helper()
	var n int
	if err := raw.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM admin_audit_logs WHERE action = 'redteam.probe.import'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRedTeamProbeCSVAtomicFailures(t *testing.T) {
	for _, stage := range []string{"pack-error", "case-error", "audit-error", "pack-ignore", "case-ignore", "audit-ignore"} {
		t.Run(stage, func(t *testing.T) {
			s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("CSV import invoked upstream") })
			before := seedProbeMetadata(t, db)
			snapshot, err := db.ListRedTeamProbePacks(t.Context(), true)
			if err != nil {
				t.Fatal(err)
			}
			audits := csvImportAuditCount(t, raw)
			row := probeCSVPublicRow("public-edited", "edited before later fault")
			row[0], row[1], row[6] = before.ID, "edited pack", "editable"
			next := probeCSVPublicRow("atomic-new-case", "synthetic new prompt")
			next[0], next[1] = "atomic-new-pack", "new pack"
			body := probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), row, next})
			cleanup := csvImportFault(t, raw, stage)
			response := probeCSVImportResponse(s, body)
			if response.Code < 500 {
				t.Errorf("uncertain import acknowledged status=%d", response.Code)
			}

			var failure struct{ Error struct{ Code string } }
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
				t.Fatal(err)
			}
			wantCode := "redteam_import_save_failed"
			if strings.HasPrefix(stage, "pack") {
				wantCode = "redteam_pack_save_failed"
			}
			if strings.HasPrefix(stage, "case") {
				wantCode = "redteam_case_save_failed"
			}
			if failure.Error.Code != wantCode {
				t.Errorf("failure code=%q want=%q", failure.Error.Code, wantCode)
			}
			if strings.Contains(response.Body.String(), "synthetic-import-database-detail") {
				t.Error("database detail leaked")
			}
			after, err := db.ListRedTeamProbePacks(t.Context(), true)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(snapshot, after) {
				t.Error("failed import left a partial pack/case change")
			}
			if csvImportAuditCount(t, raw) != audits {
				t.Error("failed import left a success audit")
			}
			cleanup()
			retry := probeCSVImportResponse(s, body)
			if retry.Code != http.StatusOK {
				t.Fatalf("explicit retry status=%d", retry.Code)
			}
			var receipt struct {
				ImportedCases int `json:"imported_cases"`
				PacksTouched  int `json:"packs_touched"`
			}
			if err := json.Unmarshal(retry.Body.Bytes(), &receipt); err != nil {
				t.Fatal(err)
			}
			if receipt.ImportedCases != 2 || receipt.PacksTouched != 2 {
				t.Errorf("incorrect committed receipt: %+v", receipt)
			}
			assertProbeMetadata(t, before, probeMetadataPack(t, db, before.ID), "edited before later fault")
			if fresh := probeMetadataPack(t, db, "atomic-new-pack"); len(fresh.Cases) != 1 {
				t.Error("new case missing after committed retry")
			}
			if csvImportAuditCount(t, raw) != audits+1 {
				t.Error("committed retry must have exactly one audit")
			}
			entries, err := db.ListAdminAudit(t.Context(), 200)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if entry.Action == "redteam.probe.import" && (strings.Contains(entry.AfterValue, "edited before later fault") || strings.Contains(entry.AfterValue, "synthetic new prompt")) {
					t.Error("raw prompt leaked into audit")
				}
			}
		})
	}
}

func TestRedTeamProbeCSVAtomicDuplicateAndSkippedRows(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("CSV import invoked upstream") })
	first := probeCSVPublicRow("atomic-duplicate", "first prompt")
	last := probeCSVPublicRow("atomic-duplicate", "last prompt")
	last[1] = "second row pack name must not replace first"
	skipped := probeCSVPublicRow("atomic-skipped", "")
	body := probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), first, skipped, last})
	response := probeCSVImportResponse(s, body)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d", response.Code)
	}
	var receipt struct {
		ImportedCases int      `json:"imported_cases"`
		PacksTouched  int      `json:"packs_touched"`
		Skipped       []string `json:"skipped"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.ImportedCases != 2 || receipt.PacksTouched != 1 || len(receipt.Skipped) != 1 {
		t.Errorf("legacy row-count semantics changed: %+v", receipt)
	}
	pack := probeMetadataPack(t, db, "public-format-pack")
	if pack.Name != first[1] || len(pack.Cases) != 1 || pack.Cases[0].InputTemplate != "last prompt" {
		t.Errorf("duplicate semantics changed: %#v", pack)
	}
	if csvImportAuditCount(t, raw) != 1 {
		t.Error("success must have one audit")
	}
}
