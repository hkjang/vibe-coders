package store

import (
	"context"
	"testing"
	"time"
)

func TestMCPPolicyAndUpstreamStoreLifecycle(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertMCPPolicy(ctx, MCPPolicy{ServerLabel: "shell", Mode: "block", Note: "critical"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPPolicy(ctx, MCPPolicy{ServerLabel: "git", Mode: "warn", Note: "review"}); err != nil {
		t.Fatal(err)
	}
	policies, err := db.ListMCPPolicies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[0].ServerLabel != "git" || policies[1].ServerLabel != "shell" {
		t.Fatalf("policies should be sorted by server label, got %+v", policies)
	}
	policyMap, err := db.MCPPolicyMap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if policyMap["shell"] != "block" || policyMap["git"] != "warn" {
		t.Fatalf("unexpected policy map: %+v", policyMap)
	}
	if err := db.UpsertMCPPolicy(ctx, MCPPolicy{ServerLabel: "shell", Mode: "allow", Note: "override"}); err != nil {
		t.Fatal(err)
	}
	policyMap, err = db.MCPPolicyMap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if policyMap["shell"] != "allow" {
		t.Fatalf("upsert should update existing policy, got %+v", policyMap)
	}
	if err := db.DeleteMCPPolicy(ctx, "git"); err != nil {
		t.Fatal(err)
	}
	policies, err = db.ListMCPPolicies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 1 || policies[0].ServerLabel != "shell" {
		t.Fatalf("delete policy failed, got %+v", policies)
	}

	if err := db.UpsertMCPUpstream(ctx, MCPUpstream{ID: "fs", Name: "File System", URL: "http://fs/mcp", EncryptedAuth: "enc", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPUpstream(ctx, MCPUpstream{ID: "db", Name: "Database", URL: "http://db/mcp", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	all, err := db.ListMCPUpstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].ID != "db" || all[1].ID != "fs" {
		t.Fatalf("upstreams should be sorted by name, got %+v", all)
	}
	active, err := db.ActiveMCPUpstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 1 || active[0].ID != "fs" || !active[0].HasAuth {
		t.Fatalf("active upstream auth metadata wrong, got %+v", active)
	}
	got, found, err := db.GetMCPUpstream(ctx, "fs")
	if err != nil || !found {
		t.Fatalf("get upstream found=%v err=%v", found, err)
	}
	if got.URL != "http://fs/mcp" || !got.Enabled || !got.HasAuth {
		t.Fatalf("unexpected upstream detail: %+v", got)
	}
	if err := db.UpsertMCPUpstream(ctx, MCPUpstream{ID: "fs", Name: "File System", URL: "http://fs2/mcp", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	got, found, err = db.GetMCPUpstream(ctx, "fs")
	if err != nil || !found {
		t.Fatalf("get updated upstream found=%v err=%v", found, err)
	}
	if got.URL != "http://fs2/mcp" || got.Enabled || got.HasAuth {
		t.Fatalf("upsert should update upstream fields, got %+v", got)
	}
	if err := db.DeleteMCPUpstream(ctx, "fs"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.GetMCPUpstream(ctx, "fs"); err != nil || found {
		t.Fatalf("deleted upstream found=%v err=%v", found, err)
	}
}

func TestMCPCatalogAndLoopDetectionFromLogRecords(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	insertToolRecord := func(id, session, server, tool, source string, isMCP bool, isError bool, when time.Time) {
		t.Helper()
		rec := LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_mcp", Endpoint: "/v1/chat/completions",
				SessionID: session, StatusCode: 200, CreatedAt: when,
			},
			Tools: []ToolInvocation{{
				ID: id + "_tool", RequestID: id, TraceID: id, APIKeyID: "key_mcp",
				ServerLabel: server, ToolName: tool, Source: source, IsMCP: isMCP,
				IsError: isError, ArgHash: id + "_args", CreatedAt: when,
			}},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}

	insertToolRecord("old_def", "sess_old", "fs", "read_file", "definition", true, false, now.Add(-48*time.Hour))
	insertToolRecord("new_def", "sess_new", "shell", "execute", "definition", true, false, now)
	for i := 0; i < 4; i++ {
		insertToolRecord("loop_"+string(rune('a'+i)), "sess_loop", "shell", "execute", "call", true, i == 2, now.Add(time.Duration(i)*time.Second))
	}
	insertToolRecord("single", "sess_single", "shell", "execute", "call", true, false, now)

	catalog, err := db.MCPCatalog(ctx, "", 24*time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	byTool := map[string]MCPCatalogEntry{}
	for _, entry := range catalog {
		byTool[entry.ServerLabel+"/"+entry.ToolName] = entry
	}
	if !byTool["shell/execute"].IsNew || byTool["shell/execute"].IsStale {
		t.Fatalf("new catalog entry flags wrong: %+v", byTool["shell/execute"])
	}
	if !byTool["fs/read_file"].IsStale || byTool["fs/read_file"].IsNew {
		t.Fatalf("stale catalog entry flags wrong: %+v", byTool["fs/read_file"])
	}
	filtered, err := db.MCPCatalog(ctx, "shell", 24*time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].ServerLabel != "shell" {
		t.Fatalf("server-filtered catalog mismatch: %+v", filtered)
	}
	newCount, err := db.CountNewCatalogTools(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if newCount != 1 {
		t.Fatalf("new catalog tool count = %d, want 1", newCount)
	}

	loops, err := db.SessionToolLoops(ctx, now.Add(-time.Hour), 3, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(loops) != 1 || loops[0].SessionID != "sess_loop" || loops[0].Calls != 4 || loops[0].Errors != 1 {
		t.Fatalf("loop detection mismatch: %+v", loops)
	}
	maxCalls, err := db.MaxSessionToolCallsSince(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if maxCalls != 4 {
		t.Fatalf("max session tool calls = %d, want 4", maxCalls)
	}
}
