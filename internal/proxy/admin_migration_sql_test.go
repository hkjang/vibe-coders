package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"vibe-coders/internal/store"
)

func getMigrationSQL(t *testing.T, ts *httptest.Server) migrationSQLResponse {
	t.Helper()
	resp, err := http.Get(ts.URL + "/admin/migration-sql")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out migrationSQLResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMigrationSQLReturnsTheWholeDeclaredSchema(t *testing.T) {
	_, ts, _ := indexHealthServer(t)

	got := getMigrationSQL(t, ts)
	if got.Counts.Total == 0 || len(got.Statements) != got.Counts.Total {
		t.Fatalf("statements=%d total=%d", len(got.Statements), got.Counts.Total)
	}
	if got.LiveError != "" {
		t.Fatalf("live comparison failed on a freshly migrated database: %s", got.LiveError)
	}
	if len(got.LiveOnly) != 0 {
		t.Fatalf("a fresh database reported hand-added indexes: %+v", got.LiveOnly)
	}
	if len(got.IndexStatus) != got.Counts.CreateIndex {
		t.Fatalf("status for %d indexes, schema declares %d", len(got.IndexStatus), got.Counts.CreateIndex)
	}
	for name, st := range got.IndexStatus {
		if st != "present" {
			t.Fatalf("freshly migrated database reports %q as %q", name, st)
		}
	}
}

// The question this endpoint exists for: an operator has added indexes by hand and can no
// longer tell which ones came from the build. Every declared index must be marked with
// what this database has, and the hand-added ones listed separately.
func TestMigrationSQLSeparatesHandAddedIndexesFromDeclaredOnes(t *testing.T) {
	_, ts, exec := indexHealthServer(t)

	exec(`DROP INDEX idx_prompt_logs_request_id`)
	exec(`CREATE INDEX idx_added_by_hand ON request_logs(user_agent)`)

	got := getMigrationSQL(t, ts)

	if st := got.IndexStatus["idx_prompt_logs_request_id"]; st != "missing" {
		t.Fatalf("a dropped index reports %q, want missing", st)
	}
	if got.IndexDetail["idx_prompt_logs_request_id"] == "" {
		t.Fatal("no detail for the missing index; an operator has to open the drift report to learn what happened")
	}
	if len(got.LiveOnly) != 1 || got.LiveOnly[0].Name != "idx_added_by_hand" {
		t.Fatalf("hand-added index not reported as live-only: %+v", got.LiveOnly)
	}
	if got.LiveOnly[0].Table != "request_logs" {
		t.Fatalf("live-only index names table %q", got.LiveOnly[0].Table)
	}
	// The hand-added one must not appear among the declared statements, which is the whole
	// basis on which an operator tells the two apart.
	if _, ok := got.IndexStatus["idx_added_by_hand"]; ok {
		t.Fatal("a hand-added index appears in index_status, so it reads as declared by the build")
	}
	for _, st := range got.Statements {
		if st.Kind == "create_index" && st.Name == "idx_added_by_hand" {
			t.Fatal("a hand-added index appears in the declared statement list")
		}
	}
	// Everything else still has to read as matching, or the answer is useless noise.
	others := 0
	for name, st := range got.IndexStatus {
		if name == "idx_prompt_logs_request_id" {
			continue
		}
		if st != "present" {
			t.Fatalf("index %q reports %q after an unrelated change", name, st)
		}
		others++
	}
	if others == 0 {
		t.Fatal("no index was reported as present; the join by name is not matching anything")
	}
}

// An index redefined under a name the migrations also use is the case CREATE INDEX IF NOT
// EXISTS hides, so it has to read differently from both "present" and "missing".
func TestMigrationSQLMarksARedefinedIndexAsMismatched(t *testing.T) {
	_, ts, exec := indexHealthServer(t)

	exec(`DROP INDEX idx_prompt_logs_request_id`)
	exec(`CREATE INDEX idx_prompt_logs_request_id ON prompt_logs(created_at)`)

	got := getMigrationSQL(t, ts)
	if st := got.IndexStatus["idx_prompt_logs_request_id"]; st != "mismatched" {
		t.Fatalf("a redefined index reports %q, want mismatched", st)
	}
	if len(got.LiveOnly) != 0 {
		t.Fatalf("a name collision was reported as a hand-added index too: %+v", got.LiveOnly)
	}
}

// A drift item naming something the statement list has no entry for must not invent a row.
// The UI renders index_status by joining on the statement list, so a phantom name would be
// a status an operator can never locate.
func TestMigrationSQLIgnoresDriftForAnIndexItDoesNotDeclare(t *testing.T) {
	statements := []store.MigrationStatement{
		{Seq: 1, Kind: "create_index", Name: "idx_real", Table: "t"},
	}
	drift := store.IndexDriftReport{Items: []store.IndexDriftItem{
		{Kind: "missing", Name: "idx_real", Table: "t", Detail: "gone"},
		{Kind: "mismatched", Name: "idx_phantom", Table: "t", Detail: "not in the list"},
	}}

	status, detail, liveOnly := annotateDeclaredIndexes(statements, drift)
	if len(status) != 1 || status["idx_real"] != "missing" {
		t.Fatalf("status = %+v", status)
	}
	if _, ok := status["idx_phantom"]; ok {
		t.Fatal("a drift item for an undeclared name created a status row with no statement behind it")
	}
	if detail["idx_real"] != "gone" {
		t.Fatalf("detail = %+v", detail)
	}
	if len(liveOnly) != 0 {
		t.Fatalf("liveOnly = %+v", liveOnly)
	}
}

// An undeclared drift item with no live definition attached must not become an empty row.
func TestMigrationSQLSkipsUndeclaredDriftWithNoLiveIndex(t *testing.T) {
	_, _, liveOnly := annotateDeclaredIndexes(nil, store.IndexDriftReport{
		Items: []store.IndexDriftItem{{Kind: "undeclared", Name: "idx_x", Table: "t"}},
	})
	if len(liveOnly) != 0 {
		t.Fatalf("a drift item with no live index produced %+v", liveOnly)
	}
}
