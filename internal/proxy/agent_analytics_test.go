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

// seedAgent logs n chat requests under a user-agent with the given success count
// and per-request tool calls/errors.
func seedAgent(t *testing.T, db *store.SQLStore, ua, model string, n, successes, toolCalls, toolErrors int, cost float64) {
	t.Helper()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < n; i++ {
		status := 200
		if i >= successes {
			status = 500
		}
		id := ua + "-" + strconv.Itoa(i)
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions", UserAgent: ua,
				Model: model, StatusCode: status, LatencyMS: 200, FirstChunkMS: 50, CreatedAt: base,
			},
			Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: base},
		}
		if i == 0 { // attach tool spans to the first request of this agent
			for j := 0; j < toolCalls; j++ {
				rec.Tools = append(rec.Tools, store.ToolInvocation{
					ID: id + "-call-" + strconv.Itoa(j), RequestID: id, TraceID: id,
					ServerLabel: "github", ToolName: "x", Source: "call", IsMCP: true, CreatedAt: base,
				})
			}
			for j := 0; j < toolErrors; j++ {
				rec.Tools = append(rec.Tools, store.ToolInvocation{
					ID: id + "-err-" + strconv.Itoa(j), RequestID: id, TraceID: id,
					ServerLabel: "github", ToolName: "x", Source: "result", IsError: true, IsMCP: true, CreatedAt: base,
				})
			}
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentAnalyticsAggregates(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Claude Code: 20 reqs, 19 success (95%), 4 tool calls, 1 tool error
	seedAgent(t, db, "claude-cli/1.0", "claude", 20, 19, 4, 1, 30)
	// Cursor: 10 reqs, 7 success (70%), no tools
	seedAgent(t, db, "Cursor/0.42", "gpt-4.1", 10, 7, 0, 0, 50)

	rep, err := db.AgentAnalytics(ctx, time.Now().Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Agents) != 2 {
		t.Fatalf("expected 2 agents, got %d (%+v)", len(rep.Agents), rep.Agents)
	}
	// sorted by requests desc → Claude Code first
	if rep.Agents[0].Agent != "Claude Code" {
		t.Fatalf("expected Claude Code first, got %q", rep.Agents[0].Agent)
	}
	cc := rep.Agents[0]
	if cc.Requests != 20 {
		t.Errorf("claude requests = %d, want 20", cc.Requests)
	}
	if cc.SuccessRate < 0.94 || cc.SuccessRate > 0.96 {
		t.Errorf("claude success rate = %.3f, want ~0.95", cc.SuccessRate)
	}
	if cc.ToolCalls != 4 || cc.ToolErrors != 1 {
		t.Errorf("claude tools = %d calls / %d errs, want 4/1", cc.ToolCalls, cc.ToolErrors)
	}
	if cc.ToolErrorRate < 0.24 || cc.ToolErrorRate > 0.26 {
		t.Errorf("claude tool error rate = %.3f, want ~0.25", cc.ToolErrorRate)
	}
	var cursor *store.AgentStat
	for i := range rep.Agents {
		if rep.Agents[i].Agent == "Cursor" {
			cursor = &rep.Agents[i]
		}
	}
	if cursor == nil || cursor.Requests != 10 || cursor.SuccessRate < 0.69 || cursor.SuccessRate > 0.71 {
		t.Fatalf("unexpected cursor stats: %+v", cursor)
	}
}

func TestAgentAnalyticsEndpoint(t *testing.T) {
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

	seedAgent(t, db, "claude-cli/1.0", "claude", 5, 5, 0, 0, 10)

	resp, err := http.Get(proxy.URL + "/admin/agents?window=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var rep store.AgentAnalytics
	if err := json.NewDecoder(resp.Body).Decode(&rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.Agents) != 1 || rep.Agents[0].Agent != "Claude Code" {
		t.Fatalf("unexpected agents: %+v", rep.Agents)
	}
}
