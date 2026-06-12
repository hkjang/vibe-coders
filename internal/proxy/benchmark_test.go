package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// seedBench logs n chat requests for a key (team via api_keys row) with successes.
func seedBench(t *testing.T, db *store.SQLStore, keyID, team string, n, successes int, cost float64, when time.Time) {
	t.Helper()
	ctx := context.Background()
	if team != "" {
		_ = db.UpsertAPIKey(ctx, store.APIKeyRecord{ID: keyID, Name: keyID, KeyHash: keyID + "-hash", Team: team, Status: "active"})
	}
	for i := 0; i < n; i++ {
		status := 200
		if i >= successes {
			status = 500
		}
		id := keyID + "-" + strconv.Itoa(i)
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, APIKeyID: keyID, SessionID: "s-" + keyID, Endpoint: "/v1/chat/completions",
				Model: "m", StatusCode: status, LatencyMS: 100, CreatedAt: when.Add(time.Duration(i) * time.Minute),
			},
			Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUserProductivityAndTeamBenchmark(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Now().UTC().Add(-2 * time.Hour)

	// alice: 20 reqs all success + 3 commits + 1 merged MR (team platform)
	seedBench(t, db, "key_alice", "platform", 20, 20, 10, base)
	for i := 0; i < 3; i++ {
		_ = db.InsertVCSEvent(ctx, store.VCSEvent{ID: "c" + strconv.Itoa(i), Provider: "gitlab", Kind: "commit", APIKeyID: "key_alice", Title: "c", CreatedAt: base})
	}
	_ = db.InsertVCSEvent(ctx, store.VCSEvent{ID: "mr1", Provider: "gitlab", Kind: "merge_request", State: "merged", APIKeyID: "key_alice", Title: "mr", CreatedAt: base})
	// bob: 10 reqs, 5 success, no VCS (team mobile)
	seedBench(t, db, "key_bob", "mobile", 10, 5, 5, base)

	users, err := db.UserProductivity(ctx, base.Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users))
	}
	var alice, bob *store.UserProductivityRow
	for i := range users {
		switch users[i].APIKeyID {
		case "key_alice":
			alice = &users[i]
		case "key_bob":
			bob = &users[i]
		}
	}
	if alice == nil || bob == nil {
		t.Fatalf("missing rows: %+v", users)
	}
	if alice.Commits != 3 || alice.MergedMRs != 1 {
		t.Fatalf("alice VCS counts wrong: %+v", alice)
	}
	if alice.SuccessRate < 0.99 || bob.SuccessRate > 0.51 {
		t.Fatalf("success rates wrong: alice=%.2f bob=%.2f", alice.SuccessRate, bob.SuccessRate)
	}
	if alice.Score <= bob.Score {
		t.Fatalf("alice should outscore bob: %d vs %d", alice.Score, bob.Score)
	}
	if alice.Team != "platform" || bob.Team != "mobile" {
		t.Fatalf("teams wrong: %+v %+v", alice, bob)
	}

	teams, err := db.TeamBenchmark(ctx, base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	byTeam := map[string]store.TeamBenchmarkRow{}
	for _, tr := range teams {
		byTeam[tr.Team] = tr
	}
	pf, ok := byTeam["platform"]
	if !ok || pf.ActiveUsers != 1 || pf.Requests != 20 || pf.Commits != 3 || pf.MergedMRs != 1 {
		t.Fatalf("platform benchmark wrong: %+v", pf)
	}
	if pf.Score != alice.Score {
		t.Fatalf("single-member team score should equal member score: %d vs %d", pf.Score, alice.Score)
	}
	if pf.Tokens != 20*100 {
		t.Fatalf("platform tokens wrong: %d", pf.Tokens)
	}
}

func TestIncidentsClusterFailoverSpikes(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	// two consecutive hours of failovers from provider "openai" (6 each),
	// then a separate hour far earlier (also 6) → expect 2 incidents.
	h1 := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Hour)
	h2 := h1.Add(time.Hour)
	h0 := h1.Add(-10 * time.Hour)
	mk := func(prefix string, when time.Time, count int) {
		for i := 0; i < count; i++ {
			id := prefix + strconv.Itoa(i)
			_ = db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_u" + strconv.Itoa(i%3), Endpoint: "/v1/chat/completions",
				Model: "m", Provider: "anthropic", Failover: true, FallbackFrom: "openai",
				StatusCode: 200, LatencyMS: 100, CreatedAt: when.Add(time.Duration(i) * time.Minute),
			}})
		}
	}
	mk("a", h1, 6)
	mk("b", h2, 6)
	mk("c", h0, 6)

	incidents, err := db.Incidents(ctx, h0.Add(-time.Hour), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(incidents) != 2 {
		t.Fatalf("expected 2 incidents (merged h1+h2, separate h0), got %d: %+v", len(incidents), incidents)
	}
	// newest first: the merged two-hour incident
	merged := incidents[0]
	if merged.Provider != "openai" || merged.Failovers != 12 {
		t.Fatalf("merged incident wrong: %+v", merged)
	}
	if merged.AffectedUsers != 3 {
		t.Fatalf("affected users should be 3 distinct keys, got %d", merged.AffectedUsers)
	}
	if incidents[1].Failovers != 6 {
		t.Fatalf("older incident wrong: %+v", incidents[1])
	}
}

func TestBenchmarkEndpoints(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	seedBench(t, db, "key_x", "platform", 5, 5, 10, time.Now().UTC().Add(-time.Hour))

	for _, path := range []string{"/admin/benchmark/teams?window=24h", "/admin/benchmark/users?window=24h", "/admin/incidents?window=24h"} {
		res, err := http.Get(proxy.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatalf("%s decode: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s status %d", path, res.StatusCode)
		}
	}
}
