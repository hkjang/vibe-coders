package store

import (
	"context"
	"testing"
	"time"
)

func TestMCPServerStatsIncludeClientIP(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	mk := func(id, ip string) {
		rec := LogRecord{
			Request: RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", ClientIP: ip, StatusCode: 200, CreatedAt: now},
			Tools: []ToolInvocation{{
				ID: id + "t", RequestID: id, TraceID: id, ToolName: "search", Source: "call", CreatedAt: now,
			}},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mk("a", "10.0.0.1")
	mk("b", "10.0.0.2")
	mk("c", "10.0.0.1") // repeat IP → still 2 distinct

	servers, err := db.ListMCPServers(ctx, ToolFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("expected 1 server bucket, got %d", len(servers))
	}
	sv := servers[0]
	if sv.ServerLabel != "(none)" {
		t.Fatalf("expected (none) server, got %q", sv.ServerLabel)
	}
	if sv.DistinctIPs != 2 {
		t.Errorf("distinct_ips = %d, want 2", sv.DistinctIPs)
	}
	if sv.SampleIP == "" {
		t.Errorf("expected a sample IP to identify the source")
	}

	tools, err := db.ListMCPTools(ctx, ToolFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].DistinctIPs != 2 || tools[0].SampleIP == "" {
		t.Fatalf("tool IP aggregation wrong: %+v", tools)
	}
}
