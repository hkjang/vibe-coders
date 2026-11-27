package proxy

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// workIntelPerfBound is how long one dashboard read may take over the seeded
// volume. It is generous on purpose: the test is there to catch a read that
// stops using the aggregates, not to benchmark a machine.
const workIntelPerfBound = 5 * time.Second

const (
	workIntelPerfDays       = 60
	workIntelPerfTeams      = 8
	workIntelPerfPerDay     = 840
	workIntelPerfCategories = 12
)

// seedWorkIntelVolume writes 50,400 facts through the store API, the way the
// worker does: batches of 500 applied behind the cursor. They cover 60 days,
// 8 teams of 25 users, 12 categories (one per top-level category), 3 models
// and about 500 repeated fingerprints.
func seedWorkIntelVolume(tb testing.TB, db *store.SQLStore) int {
	tb.Helper()
	ctx := context.Background()
	engine := workintel.DefaultEngine()
	categories := make([]string, 0, workIntelPerfCategories)
	for _, top := range workintel.RequiredTopLevelIDs() {
		id := top
		if children := engine.Children(top); len(children) > 0 {
			id = children[0].ID
		}
		categories = append(categories, id)
	}
	if len(categories) != workIntelPerfCategories {
		tb.Fatalf("%d categories", len(categories))
	}
	models := []struct{ name, provider string }{{"model-large", "p1"}, {"model-small", "p1"}, {"model-local", "p2"}}
	actions := []string{"create", "analyze", "modify", "read"}
	cursor, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		tb.Fatal(err)
	}
	ingested := time.Now().Add(-30 * time.Minute)
	now := time.Now()
	total := 0
	batch := make([]store.WorkClassification, 0, store.WorkIntelMaxBatch)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		last := batch[len(batch)-1]
		next := store.WorkIntelCursor{IngestedAt: last.IngestedAt, RequestID: last.RequestID}
		res, err := db.ApplyWorkIntelBatch(ctx, batch, cursor, next)
		if err != nil || res.Inserted != len(batch) {
			tb.Fatalf("apply batch: %+v, %v", res, err)
		}
		cursor, total = next, total+len(batch)
		batch = batch[:0]
	}
	for day := 0; day < workIntelPerfDays; day++ {
		base := now.AddDate(0, 0, -(workIntelPerfDays - 1 - day)).Add(-time.Hour)
		for i := 0; i < workIntelPerfPerDay; i++ {
			team := i % workIntelPerfTeams
			user := (i/workIntelPerfTeams + day) % 25
			category := categories[(i*7+day)%workIntelPerfCategories]
			model := models[(i+day)%len(models)]
			ingested = ingested.Add(time.Microsecond)
			fact := store.WorkClassification{
				RequestID: fmt.Sprintf("perf-%02d-%04d", day, i), CreatedAt: base.Add(time.Duration(i) * time.Second).UTC().Format("2006-01-02T15:04:05.000000000Z"),
				IngestedAt: ingested.UTC().Format("2006-01-02T15:04:05.000000000Z"),
				SessionID:  fmt.Sprintf("s-%02d-%d-%02d-%d", day, team, user, i%3), Team: fmt.Sprintf("team-%d", team), UserKey: fmt.Sprintf("user-%d-%02d", team, user),
				APIKeyID: fmt.Sprintf("key-%d-%02d", team, user), Model: model.name, Provider: model.provider, Client: []string{"Claude Code", "Cursor"}[i%2],
				Endpoint: "/v1/chat/completions", CategoryID: category, ActionType: actions[i%len(actions)], Confidence: 0.55 + float64(i%9)*0.05,
				Method: workintel.MethodRule, Status: workintel.StatusClassified, Tags: []string{}, Technologies: []string{},
				Fingerprint: fmt.Sprintf("fp-%03d", (i*13+day)%500), TokensIn: int64(200 + i%300), TokensOut: int64(50 + i%120), CostKRW: 3 + float64(i%40)/4,
				LatencyMS: int64((i * 37) % 20000), IsError: i%53 == 0, MCPCalls: int64(i % 4 / 3),
			}
			// A share of what lands in "other" is the unclassified remainder.
			if category == workintel.OtherCategoryID || workintel.OtherCategoryID == category[:min(len(category), 5)] {
				if i%2 == 0 {
					fact.CategoryID, fact.Status, fact.Confidence = workintel.OtherCategoryID, workintel.StatusUnclassified, 0
				}
			}
			if batch = append(batch, fact); len(batch) == store.WorkIntelMaxBatch {
				flush()
			}
		}
	}
	flush()
	return total
}

// The dashboard reads answer from the aggregates: over 50,000 facts each of
// them stays well inside the bound, on SQLite and on PostgreSQL.
func TestWorkIntelDashboardReadsStayFast(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 50,000 facts")
	}
	// A scale test: seeding takes minutes and the bound means nothing under the
	// race detector, so it runs only when asked for.
	if os.Getenv("TEST_WORK_INTEL_SCALE") != "1" {
		t.Skip("scale test: run with TEST_WORK_INTEL_SCALE=1 (without -race), on SQLite or with TEST_POSTGRES_DSN, e.g. " +
			"TEST_WORK_INTEL_SCALE=1 go test ./internal/proxy -run TestWorkIntelDashboardReadsStayFast -count=1")
	}
	isolateWorkIntelLogs(t)
	db, _ := workIntelStores(t)
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig("http://unused.invalid", "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	facts := seedWorkIntelVolume(t, db)
	if facts < 50000 {
		t.Fatalf("seeded %d facts", facts)
	}
	t.Logf("seeded %d facts in %s", facts, time.Since(started).Round(time.Millisecond))
	routes := server.Routes()
	read := func(path string) (time.Duration, []byte) {
		t.Helper()
		// The best of three: the first read of a table pays for a cold cache.
		best := time.Duration(0)
		var body []byte
		for i := 0; i < 3; i++ {
			begin := time.Now()
			w := httptest.NewRecorder()
			routes.ServeHTTP(w, httptest.NewRequest(http.MethodGet, workIntelAdminPath+path, nil))
			took := time.Since(begin)
			if w.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s", path, w.Code, w.Body.String())
			}
			if best == 0 || took < best {
				best, body = took, w.Body.Bytes()
			}
		}
		return best, body
	}
	for _, path := range []string{"/overview", "/categories", "/trend", "/matrix", "/flow", "/teams", "/models"} {
		took, body := read(path)
		t.Logf("GET %-11s %8s  (%d bytes)", path, took.Round(100*time.Microsecond), len(body))
		if took > workIntelPerfBound {
			t.Errorf("GET %s took %s, more than %s", path, took, workIntelPerfBound)
		}
	}
	// The numbers are those of the seed: the default period is the last 30 of
	// the 60 days, 840 requests a day.
	var overview workOverviewResponse
	if _, body := read("/overview"); true {
		decode(t, body, &overview)
	}
	if overview.Current.Requests != 30*workIntelPerfPerDay || overview.Previous == nil || overview.Previous.Requests != 30*workIntelPerfPerDay ||
		overview.Current.Teams != workIntelPerfTeams || overview.Current.Users == nil || *overview.Current.Users != workIntelPerfTeams*25 {
		t.Errorf("overview over the seed = %+v / %+v", overview.Current, overview.Previous)
	}
	var categories workCategoriesResponse
	if _, body := read("/categories?metric=requests"); true {
		decode(t, body, &categories)
	}
	var rows int64
	for _, row := range categories.Rows {
		rows += row.Current.Requests
	}
	if len(categories.Rows) != workIntelPerfCategories || rows+categories.Unclassified.Requests != categories.Total.Requests ||
		categories.Total.Requests != 30*workIntelPerfPerDay || categories.Unclassified.Requests == 0 {
		t.Errorf("categories over the seed: %d rows, %d + %d unclassified of %d", len(categories.Rows), rows, categories.Unclassified.Requests, categories.Total.Requests)
	}
	// The other reads of the screens, for the record.
	for _, path := range []string{"/trend?bucket=week&metric=users", "/sessions", "/requests", "/productivity", "/trends", "/review", "/models?metric=cost&category=dev"} {
		took, _ := read(path)
		t.Logf("GET %-32s %8s", path, took.Round(100*time.Microsecond))
	}
	begin := time.Now()
	generation, err := server.workIntelGenerate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("generation: %d candidates, %d insights in %s", generation.Candidates, generation.Insights, time.Since(begin).Round(time.Millisecond))
	if generation.Candidates == 0 {
		t.Errorf("no repeated pattern was found in the seed")
	}
}
