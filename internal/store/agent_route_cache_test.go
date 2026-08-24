package store

import (
	"context"
	"testing"
)

func seedAgentRoute(t *testing.T, db *SQLStore, id, model, backing string, enabled bool, tools []string) {
	t.Helper()
	if err := db.UpsertAgentRoute(context.Background(), AgentRoute{
		ID: id, VirtualModel: model, Name: id, Enabled: enabled, BackingModel: backing,
		MCPUpstreams: []string{"mcp-a"}, AllowedTools: tools, MaxSteps: 3,
	}); err != nil {
		t.Fatalf("upsert %s: %v", id, err)
	}
}

// Every /v1 request asks this question, so repeat calls must not go back to the database.
func TestGetAgentRouteByModelServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedAgentRoute(t, db, "a1", "agent-x", "gpt-4.1", true, []string{"search"})
	if got, ok, err := db.GetAgentRouteByModel(ctx, "agent-x"); err != nil || !ok || got.BackingModel != "gpt-4.1" {
		t.Fatalf("first read: %+v %v %v", got, ok, err)
	}

	if _, err := db.db.ExecContext(ctx, db.bind(
		`UPDATE agent_routes SET backing_model = ? WHERE id = ?`), "behind-its-back", "a1"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := db.GetAgentRouteByModel(ctx, "agent-x")
	if err != nil || !ok {
		t.Fatalf("second read: %v %v", ok, err)
	}
	if got.BackingModel != "gpt-4.1" {
		t.Fatalf("second read went to the database instead of the cache: %q", got.BackingModel)
	}

	// A model that is not a route is the common answer, and it has to be cached too —
	// otherwise every ordinary request still pays for the lookup.
	if _, ok, err := db.GetAgentRouteByModel(ctx, "gpt-4.1"); err != nil || ok {
		t.Fatalf("a plain model reported as an agent route: %v %v", ok, err)
	}
}

// An operator adding, editing or disabling a route has to see it on the very next request.
func TestAgentRouteWritesTakeEffectImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedAgentRoute(t, db, "a1", "agent-x", "gpt-4.1", true, []string{"search"})
	if _, _, err := db.GetAgentRouteByModel(ctx, "agent-x"); err != nil { // prime
		t.Fatal(err)
	}

	seedAgentRoute(t, db, "a1", "agent-x", "claude-4", true, []string{"search", "fetch"})
	got, ok, err := db.GetAgentRouteByModel(ctx, "agent-x")
	if err != nil || !ok {
		t.Fatal(err)
	}
	if got.BackingModel != "claude-4" || len(got.AllowedTools) != 2 {
		t.Fatalf("edit not visible: %+v", got)
	}

	// Disabled routes stay resolvable; the caller decides what disabled means. What must
	// not happen is the cache still reporting it as enabled.
	seedAgentRoute(t, db, "a1", "agent-x", "claude-4", false, []string{"search"})
	got, ok, _ = db.GetAgentRouteByModel(ctx, "agent-x")
	if !ok {
		t.Fatal("a disabled route disappeared instead of being reported as disabled")
	}
	if got.Enabled {
		t.Fatal("a disabled route is still reported as enabled")
	}

	if err := db.DeleteAgentRoute(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := db.GetAgentRouteByModel(ctx, "agent-x"); ok {
		t.Fatal("a deleted route is still routed")
	}
}

// AgentRoute carries string slices. Handing out the cached ones would let one request's
// edit change what every later request routes with.
func TestGetAgentRouteByModelReturnsACopy(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedAgentRoute(t, db, "a1", "agent-x", "gpt-4.1", true, []string{"search", "fetch"})

	loaded, _, err := db.GetAgentRouteByModel(ctx, "agent-x")
	if err != nil {
		t.Fatal(err)
	}
	loaded.AllowedTools[0] = "mutated-after-load"
	loaded.MCPUpstreams[0] = "mutated-after-load"
	if got, _, _ := db.GetAgentRouteByModel(ctx, "agent-x"); got.AllowedTools[0] != "search" || got.MCPUpstreams[0] != "mcp-a" {
		t.Fatalf("editing the loaded route leaked into the cache: %+v", got)
	}

	cached, _, err := db.GetAgentRouteByModel(ctx, "agent-x")
	if err != nil {
		t.Fatal(err)
	}
	cached.AllowedTools[0] = "mutated-after-hit"
	cached.MCPUpstreams[0] = "mutated-after-hit"
	if got, _, _ := db.GetAgentRouteByModel(ctx, "agent-x"); got.AllowedTools[0] != "search" || got.MCPUpstreams[0] != "mcp-a" {
		t.Fatalf("editing a cache hit leaked into the cache: %+v", got)
	}
}
