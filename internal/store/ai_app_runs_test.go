package store

import (
	"context"
	"testing"
)

func TestAIAppRunsRoundtrip(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	mk := func(id, app, user string) {
		if err := db.RecordAIAppRun(ctx, AIAppRun{ID: id, AppID: app, UserID: user, Team: "t1", InputHash: "h", LatencyMS: 5}); err != nil {
			t.Fatal(err)
		}
	}
	mk("r1", "app_a", "alice")
	mk("r2", "app_b", "alice")
	mk("r3", "app_a", "bob")

	all, err := db.ListAIAppRuns(ctx, "alice", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("alice should have 2 runs, got %d", len(all))
	}
	if all[0].Status != "planned" {
		t.Fatalf("default status should be planned, got %q", all[0].Status)
	}

	byApp, _ := db.ListAIAppRuns(ctx, "alice", "app_a", 50)
	if len(byApp) != 1 || byApp[0].ID != "r1" {
		t.Fatalf("app filter wrong: %+v", byApp)
	}
	// Per-user isolation.
	if bob, _ := db.ListAIAppRuns(ctx, "bob", "", 50); len(bob) != 1 {
		t.Fatalf("bob should have 1 run, got %d", len(bob))
	}

	// Single-run getter (for receipts).
	got, found, err := db.GetAIAppRun(ctx, "r1")
	if err != nil || !found || got.AppID != "app_a" || got.UserID != "alice" {
		t.Fatalf("GetAIAppRun(r1) = %+v found=%v err=%v", got, found, err)
	}
	if _, found, _ := db.GetAIAppRun(ctx, "nope"); found {
		t.Fatal("unknown run should not be found")
	}

	// trace_id stamping + AIAppRunsByTrace.
	if err := db.RecordAIAppRun(ctx, AIAppRun{ID: "r4", AppID: "app_a", UserID: "alice", TraceID: "trace_y"}); err != nil {
		t.Fatal(err)
	}
	byTrace, err := db.AIAppRunsByTrace(ctx, "trace_y")
	if err != nil || len(byTrace) != 1 || byTrace[0].ID != "r4" || byTrace[0].TraceID != "trace_y" {
		t.Fatalf("AIAppRunsByTrace = %+v err=%v", byTrace, err)
	}
}
