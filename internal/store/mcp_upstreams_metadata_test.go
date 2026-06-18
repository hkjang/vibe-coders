package store

import (
	"context"
	"testing"
)

func TestMCPUpstreamMetadataLifecycle(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	meta := MCPUpstreamMetadata{
		Description:      "Company policy and HR rules",
		Domains:          []string{"policy", "hr", "policy", ""},
		RiskLevel:        "medium",
		AllowedModels:    []string{"vibe/grounded", "vibe/policy"},
		DefaultTool:      "search",
		TimeoutMS:        3000,
		MaxResults:       4,
		RequiresApproval: false,
		FallbackAllowed:  false,
	}
	if err := db.UpsertMCPUpstream(ctx, MCPUpstream{ID: "policy", Name: "Policy MCP", URL: "http://mcp.example", Enabled: true, Metadata: meta}); err != nil {
		t.Fatal(err)
	}

	up, found, err := db.GetMCPUpstream(ctx, "policy")
	if err != nil || !found {
		t.Fatalf("metadata upstream lookup failed found=%v err=%v", found, err)
	}
	if up.Metadata.Description != meta.Description || up.Metadata.RiskLevel != "medium" || up.Metadata.Domains[0] != "policy" || len(up.Metadata.Domains) != 2 {
		t.Fatalf("metadata normalization mismatch: %+v", up.Metadata)
	}
	if up.Metadata.AllowedModels[1] != "vibe/policy" || up.Metadata.DefaultTool != "search" || up.Metadata.TimeoutMS != 3000 || up.Metadata.MaxResults != 4 {
		t.Fatalf("metadata fields mismatch: %+v", up.Metadata)
	}

	up.Metadata.RiskLevel = "critical"
	up.Metadata.AllowedModels = []string{"vibe/all-mcp"}
	up.MetadataJSON = ""
	if err := db.UpsertMCPUpstream(ctx, up); err != nil {
		t.Fatal(err)
	}
	active, err := db.ActiveMCPUpstreams(ctx)
	if err != nil || len(active) != 1 || active[0].Metadata.RiskLevel != "critical" || active[0].Metadata.AllowedModels[0] != "vibe/all-mcp" {
		t.Fatalf("active metadata mismatch active=%+v err=%v", active, err)
	}
	if decoded := decodeMCPUpstreamMetadata(`{"risk_level":"bad","domains":["Legal","legal"]}`); decoded.RiskLevel != "low" || len(decoded.Domains) != 1 || decoded.Domains[0] != "legal" {
		t.Fatalf("decode metadata mismatch: %+v", decoded)
	}
}
