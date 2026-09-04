package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestBuildRequestTrace(t *testing.T) {
	start := time.Date(2026, 6, 23, 10, 0, 0, 0, time.UTC)
	d := store.RequestDetail{
		Request: store.RecentRequest{
			ID: "req_1", TraceID: "trace_1", Model: "vibe/auto", Endpoint: "/v1/chat/completions",
			Provider: "openai", StatusCode: 200, LatencyMS: 1200, TotalTokens: 800, EstimatedCost: 12.5,
			CreatedAt: start.Format(time.RFC3339Nano),
		},
		Text2SQLSpans: []store.Text2SQLSpan{
			{ID: "t1", Stage: "generate", Status: "ok", LatencyMS: 300, CostKRW: 5, CreatedAt: start.Add(100 * time.Millisecond)},
			{ID: "t2", Stage: "execute", Status: "ok", LatencyMS: 200, CreatedAt: start.Add(450 * time.Millisecond)},
		},
		Tools: []store.ToolInvocation{
			{ID: "tool1", ToolName: "search", ServerLabel: "github", Source: "call", IsMCP: true, CreatedAt: start.Add(700 * time.Millisecond)},
			{ID: "def1", ToolName: "search", Source: "definition", CreatedAt: start}, // must be ignored
			{ID: "tool2", ToolName: "shell", Source: "call", IsError: true, CreatedAt: start.Add(900 * time.Millisecond)},
		},
	}
	tr := buildRequestTrace(d)

	if tr.RequestID != "req_1" || tr.TraceID != "trace_1" {
		t.Fatalf("ids wrong: %+v", tr)
	}
	// root + 2 text2sql + 2 tool calls (definition excluded) = 5.
	if len(tr.Spans) != 5 {
		t.Fatalf("expected 5 spans, got %d: %+v", len(tr.Spans), tr.Spans)
	}
	root := tr.Spans[0]
	if root.Kind != "request" || root.DurationMS != 1200 || root.Tokens != 800 || root.StartOffsetMS != 0 {
		t.Fatalf("root span wrong: %+v", root)
	}
	// Children sorted by offset: t2s generate(100), t2s execute(450), tool github(700), tool shell(900).
	if tr.Spans[1].Name != "text2sql:generate" || tr.Spans[1].StartOffsetMS != 100 {
		t.Fatalf("span[1] wrong: %+v", tr.Spans[1])
	}
	if tr.Spans[3].Name != "github.search" || tr.Spans[3].Kind != "mcp_tool" {
		t.Fatalf("span[3] wrong: %+v", tr.Spans[3])
	}
	if tr.Spans[4].Status != "error" {
		t.Fatalf("errored tool should be status=error: %+v", tr.Spans[4])
	}
	// total = max(latency 1200, last child offset 900) = 1200.
	if tr.TotalMS != 1200 {
		t.Fatalf("total_ms = %d, want 1200", tr.TotalMS)
	}
}

func TestRequestTraceRejectsNonGetAndInvalidIDs(t *testing.T) {
	server := &Server{}

	method := httptest.NewRecorder()
	server.handleRequestTrace(method, httptest.NewRequest(http.MethodPost, "/admin/requests/req-1/trace", nil))
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", method.Code, http.StatusMethodNotAllowed)
	}

	invalid := httptest.NewRecorder()
	server.handleRequestTrace(invalid, httptest.NewRequest(http.MethodGet, "/admin/requests//trace", nil))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid ID status = %d, want %d", invalid.Code, http.StatusBadRequest)
	}
}

func TestBuildRequestTraceErrorRoot(t *testing.T) {
	tr := buildRequestTrace(store.RequestDetail{Request: store.RecentRequest{ID: "r", StatusCode: 500, Error: "boom", LatencyMS: 50}})
	if len(tr.Spans) != 1 || tr.Spans[0].Status != "error" || tr.Spans[0].Error != "boom" {
		t.Fatalf("error root wrong: %+v", tr.Spans)
	}
}
