package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMCPCatalogTracksToolsAndDrift(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// an "old" tool seen 40 days ago, and a "new" tool seen now, both under github
	mk := func(id, server, tool string, when time.Time) store.LogRecord {
		return store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: when},
			Tools: []store.ToolInvocation{
				{ID: id + "-t", RequestID: id, TraceID: id, ServerLabel: server, ToolName: tool, Source: "definition", IsMCP: true, CreatedAt: when},
			},
		}
	}
	if err := db.InsertLogRecord(ctx, mk("c1", "github", "list_issues", now.Add(-40*24*time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(ctx, mk("c2", "github", "delete_repo", now)); err != nil {
		t.Fatal(err)
	}

	cat, err := db.MCPCatalog(ctx, "github", 24*time.Hour, 30*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat) != 2 {
		t.Fatalf("expected 2 catalog entries, got %d", len(cat))
	}
	byTool := map[string]store.MCPCatalogEntry{}
	for _, e := range cat {
		byTool[e.ToolName] = e
	}
	if !byTool["delete_repo"].IsNew {
		t.Error("delete_repo should be flagged as new")
	}
	if byTool["list_issues"].IsNew {
		t.Error("list_issues should NOT be new")
	}
	if !byTool["list_issues"].IsStale {
		t.Error("list_issues (40d old) should be stale")
	}

	n, err := db.CountNewCatalogTools(ctx, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 new tool, got %d", n)
	}

	// re-seeing a tool updates last_seen but not first_seen (no false drift)
	if err := db.InsertLogRecord(ctx, mk("c3", "github", "list_issues", now)); err != nil {
		t.Fatal(err)
	}
	cat, _ = db.MCPCatalog(ctx, "github", 24*time.Hour, 30*24*time.Hour)
	for _, e := range cat {
		if e.ToolName == "list_issues" && e.IsNew {
			t.Error("re-seen old tool must not become 'new'")
		}
	}
}

func TestToolArgSensitiveFlaggedEndToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// a prior tool call whose arguments embed an API key (sensitive)
	reqBody := map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "deploy"},
			map[string]any{"role": "assistant", "tool_calls": []any{
				map[string]any{"function": map[string]any{"name": "mcp__deploy__run", "arguments": `{"token":"sk-abcdefghijklmnopqrstuvwxyz123456"}`}},
			}},
		},
	}
	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", reqBody)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	waitFor(t, 2*time.Second, func() bool {
		tools, err := db.ListMCPTools(context.Background(), store.ToolFilter{})
		return err == nil && len(tools) > 0
	})

	// find the request and confirm the tool invocation is flagged sensitive + evaluation failed
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) == 0 {
		t.Fatalf("no recent request: %v", err)
	}
	detailResp, err := http.Get(proxy.URL + "/admin/requests/" + recent[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	var detail store.RequestDetail
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	var sensitiveSeen bool
	for _, tl := range detail.Tools {
		if tl.ArgSensitive {
			sensitiveSeen = true
		}
	}
	if !sensitiveSeen {
		t.Fatalf("expected a tool flagged arg_sensitive, got %#v", detail.Tools)
	}
	var evalFound, evalFailed bool
	for _, e := range detail.Evaluations {
		if e.Name == "tools.args_no_secret" {
			evalFound = true
			evalFailed = !e.Passed
		}
	}
	if !evalFound || !evalFailed {
		t.Fatalf("expected tools.args_no_secret to be present and failing (found=%v failed=%v)", evalFound, evalFailed)
	}
}
