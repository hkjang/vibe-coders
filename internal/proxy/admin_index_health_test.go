package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// indexHealthServer runs the endpoint over a SQLite file the test also holds a raw
// connection to, so DDL can be applied behind the store's back the way an operator would
// apply it in production. Pinned to SQLite deliberately: what varies by driver is index
// introspection, which is covered where it lives, in the store package. What is under
// test here is the HTTP surface, and that is the same on both.
func indexHealthServer(t *testing.T) (*store.SQLStore, *httptest.Server, func(string)) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gateway.db")
	db, err := store.Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })

	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { raw.Close() })
	exec := func(q string) {
		t.Helper()
		if _, err := raw.ExecContext(context.Background(), q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	return db, ts, exec
}

func getIndexHealth(t *testing.T, ts *httptest.Server) indexHealthResponse {
	t.Helper()
	resp, err := http.Get(ts.URL + "/admin/index-health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out indexHealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestIndexHealthReportsACleanDatabase(t *testing.T) {
	_, ts, _ := indexHealthServer(t)

	got := getIndexHealth(t, ts)
	if !got.Summary.InSync {
		t.Fatalf("a freshly migrated database reported drift: %+v", got.Drift.Items)
	}
	if got.Drift.DeclaredCount == 0 {
		t.Fatal("declared_count is zero; the endpoint is not reading the migrations")
	}
	if got.Summary.Headline == "" {
		t.Fatal("no headline; an operator opening this sees a table of numbers and no verdict")
	}
}

// The console has to show the drift, not just count it — an operator needs the name, the
// table and something they can act on.
func TestIndexHealthSurfacesDrift(t *testing.T) {
	_, ts, exec := indexHealthServer(t)

	exec(`DROP INDEX idx_prompt_logs_request_id`)
	exec(`CREATE INDEX idx_by_hand ON request_logs(user_agent)`)

	got := getIndexHealth(t, ts)
	if got.Summary.InSync {
		t.Fatal("reported in sync after an index was dropped and another added by hand")
	}
	if got.Summary.Missing != 1 || got.Summary.Undeclared != 1 {
		t.Fatalf("summary did not count both kinds: %+v", got.Summary)
	}
	if !strings.Contains(got.Summary.Headline, "declares indexes this database does not have") {
		t.Fatalf("headline does not name the worst problem: %q", got.Summary.Headline)
	}
	var sawMissing, sawUndeclared bool
	for _, it := range got.Drift.Items {
		switch it.Kind {
		case "missing":
			sawMissing = it.Name == "idx_prompt_logs_request_id" && it.Fix != ""
		case "undeclared":
			sawUndeclared = it.Name == "idx_by_hand" && it.Table == "request_logs" && it.Fix != ""
		}
	}
	if !sawMissing || !sawUndeclared {
		t.Fatalf("items did not describe both drifts with a fix: %+v", got.Drift.Items)
	}
}

// The headline is the one line an operator reads. It has to name the worst thing present,
// not the first thing found.
func TestIndexHealthHeadlineNamesTheWorstProblem(t *testing.T) {
	clean := store.IndexDriftReport{Items: []store.IndexDriftItem{}}
	cases := []struct {
		name   string
		drift  store.IndexDriftReport
		advice store.IndexAdviceReport
		want   string
	}{
		{"mismatched outranks missing",
			store.IndexDriftReport{Items: []store.IndexDriftItem{{Kind: "missing"}, {Kind: "mismatched"}}},
			store.IndexAdviceReport{}, "does not match the definition"},
		{"missing outranks undeclared",
			store.IndexDriftReport{Items: []store.IndexDriftItem{{Kind: "undeclared"}, {Kind: "missing"}}},
			store.IndexAdviceReport{}, "declares indexes this database does not have"},
		{"a high-severity scan outranks an undeclared index",
			store.IndexDriftReport{Items: []store.IndexDriftItem{{Kind: "undeclared"}}},
			store.IndexAdviceReport{Items: []store.IndexAdvice{{Severity: "high"}}}, "scanning tables"},
		{"undeclared alone",
			store.IndexDriftReport{Items: []store.IndexDriftItem{{Kind: "undeclared"}}},
			store.IndexAdviceReport{}, "a fresh install will not have them"},
		{"advice only",
			clean, store.IndexAdviceReport{Items: []store.IndexAdvice{{Severity: "low"}}},
			"suggestions worth reading"},
		{"nothing to say",
			clean, store.IndexAdviceReport{}, "nothing stands out"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeIndexHealth(tc.drift, tc.advice)
			if !strings.Contains(got.Headline, tc.want) {
				t.Fatalf("headline %q does not contain %q", got.Headline, tc.want)
			}
		})
	}
}

// Read-only means read-only. An endpoint that silently created indexes would be changing
// the write path of a production database from a GET.
func TestIndexHealthChangesNothing(t *testing.T) {
	db, ts, _ := indexHealthServer(t)
	ctx := context.Background()

	before, err := db.LiveIndexes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	getIndexHealth(t, ts)
	after, err := db.LiveIndexes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("the report changed the schema: %d indexes before, %d after", len(before), len(after))
	}
}
