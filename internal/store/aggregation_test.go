package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

// openAggTestStore spins up a fresh migrated SQLite store in a temp dir.
func openAggTestStore(t *testing.T) *SQLStore {
	t.Helper()
	db, err := Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "agg.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return db
}

func insertReq(t *testing.T, db *SQLStore, id, apiKeyID string, latency int64, tokens int, when time.Time) {
	t.Helper()
	rec := LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, Endpoint: "/v1/chat/completions",
			Model: "gpt-4.1", StatusCode: 200, LatencyMS: latency, CreatedAt: when,
		},
	}
	if tokens > 0 {
		rec.Usage = &TokenUsage{
			ID: id + "-u", RequestID: id, PromptTokens: tokens / 2, CompletionTokens: tokens - tokens/2,
			TotalTokens: tokens, EstimatedCost: 1, Currency: "KRW", Source: "usage", CreatedAt: when,
		}
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

// TestAggregationsIncludePassthroughAndAnonymous is the regression guard for the bug
// where traffic logged under synthetic api_key_id values (passthrough / anonymous)
// — which have no api_keys row — was dropped from user/team aggregates.
func TestAggregationsIncludePassthroughAndAnonymous(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// a configured key in team "platform"
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_abc", Name: "dev", Team: "platform", KeyHash: "h", Status: "active"}); err != nil {
		t.Fatal(err)
	}

	insertReq(t, db, "r1", "passthrough", 100, 10, now.Add(-3*time.Minute))
	insertReq(t, db, "r2", "passthrough", 300, 20, now.Add(-2*time.Minute))
	insertReq(t, db, "r3", "anonymous", 50, 0, now.Add(-time.Minute))
	insertReq(t, db, "r4", "key_abc", 200, 5, now)

	// ---- ListUsers ----
	users, err := db.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]UserSummary{}
	for _, u := range users {
		byID[u.APIKeyID] = u
	}
	pt, ok := byID["passthrough"]
	if !ok {
		t.Fatalf("passthrough user missing from ListUsers: %#v", users)
	}
	if pt.Requests != 2 || pt.Tokens != 30 {
		t.Fatalf("passthrough aggregates wrong: req=%d tok=%d", pt.Requests, pt.Tokens)
	}
	if pt.AverageLatencyMS != 200 { // (100+300)/2
		t.Fatalf("passthrough avg latency = %v, want 200", pt.AverageLatencyMS)
	}
	if pt.LastSeen == "" {
		t.Fatal("passthrough last_seen should be set")
	}
	if pt.Name != "패스스루 (직접 키)" {
		t.Fatalf("passthrough friendly name wrong: %q", pt.Name)
	}
	if anon, ok := byID["anonymous"]; !ok || anon.Requests != 1 {
		t.Fatalf("anonymous user missing or wrong: %#v", byID["anonymous"])
	}
	if dev, ok := byID["key_abc"]; !ok || dev.Requests != 1 || dev.Tokens != 5 {
		t.Fatalf("configured key aggregates wrong: %#v", byID["key_abc"])
	}

	// ---- ListTeams ----
	teams, err := db.ListTeams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	teamByName := map[string]TeamSummary{}
	for _, tm := range teams {
		teamByName[tm.Team] = tm
	}
	un, ok := teamByName["unassigned"]
	if !ok {
		t.Fatalf("unassigned team missing: %#v", teams)
	}
	if un.Requests != 3 || un.Tokens != 30 { // passthrough(2)+anonymous(1)
		t.Fatalf("unassigned team aggregates wrong: req=%d tok=%d", un.Requests, un.Tokens)
	}
	if un.Keys != 2 { // passthrough + anonymous
		t.Fatalf("unassigned distinct keys = %d, want 2", un.Keys)
	}
	if plat, ok := teamByName["platform"]; !ok || plat.Requests != 1 {
		t.Fatalf("platform team aggregates wrong: %#v", teamByName["platform"])
	}

	// ---- GetUserDetail for a synthetic id should not 404 ----
	detail, err := db.GetUserDetail(ctx, "passthrough", 10)
	if err != nil {
		t.Fatalf("GetUserDetail(passthrough) errored: %v", err)
	}
	if detail.Stats.Requests != 2 || detail.Stats.Tokens != 30 {
		t.Fatalf("passthrough detail stats wrong: %#v", detail.Stats)
	}
	if len(detail.Recent) != 2 {
		t.Fatalf("expected 2 recent rows for passthrough, got %d", len(detail.Recent))
	}

	// unknown id with no traffic must still 404
	if _, err := db.GetUserDetail(ctx, "never_seen", 10); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound for unknown id, got %v", err)
	}

	// ---- GetTeamDetail unassigned should include synthetic traffic ----
	td, err := db.GetTeamDetail(ctx, "unassigned", 10)
	if err != nil {
		t.Fatalf("GetTeamDetail(unassigned) errored: %v", err)
	}
	if td.Stats.Requests != 3 {
		t.Fatalf("unassigned team detail requests = %d, want 3", td.Stats.Requests)
	}
}
