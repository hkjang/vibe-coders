package store

import (
	"context"
	"testing"
)

func TestAgentRouteCRUD(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	route := AgentRoute{
		ID: "agr_1", VirtualModel: "vibe/agent-research", Name: "Research",
		Enabled: true, BackingModel: "gpt-4o", Provider: "openai",
		MCPUpstreams: []string{"github", "confluence"}, AllowedTools: []string{"search", "read_page"},
		SystemPrompt: "너는 리서치 에이전트다", MaxSteps: 6, MaxCostKRW: 12.5,
	}
	if err := db.UpsertAgentRoute(ctx, route); err != nil {
		t.Fatal(err)
	}

	got, found, err := db.GetAgentRouteByModel(ctx, "vibe/agent-research")
	if err != nil || !found {
		t.Fatalf("route not found: %v", err)
	}
	if got.BackingModel != "gpt-4o" || got.Provider != "openai" || len(got.MCPUpstreams) != 2 || got.MaxSteps != 6 || !got.Enabled {
		t.Fatalf("round-trip mismatch: %#v", got)
	}
	if len(got.AllowedTools) != 2 || got.MaxCostKRW != 12.5 {
		t.Fatalf("allowed_tools/max_cost round-trip mismatch: %#v", got)
	}

	// Update in place (same id): flip enabled and shrink MCP set.
	route.Enabled = false
	route.MCPUpstreams = []string{"github"}
	if err := db.UpsertAgentRoute(ctx, route); err != nil {
		t.Fatal(err)
	}
	got, _, _ = db.GetAgentRouteByModel(ctx, "vibe/agent-research")
	if got.Enabled || len(got.MCPUpstreams) != 1 {
		t.Fatalf("update did not apply: %#v", got)
	}

	list, err := db.ListAgentRoutes(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("expected 1 route, got %d (err=%v)", len(list), err)
	}

	if err := db.DeleteAgentRoute(ctx, "agr_1"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetAgentRouteByModel(ctx, "vibe/agent-research"); found {
		t.Fatal("route should be deleted")
	}
}
