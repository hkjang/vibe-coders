package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSessionTimelineCumulativeCost(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)

	mk := func(id string, cost float64, tokens int, toolCalls int, status int, offset time.Duration) {
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, SessionID: "sess-x", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", StatusCode: status, LatencyMS: 100, FirstChunkMS: 40,
				CreatedAt: base.Add(offset),
			},
			Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: base.Add(offset)},
		}
		for i := 0; i < toolCalls; i++ {
			rec.Tools = append(rec.Tools, store.ToolInvocation{
				ID: id + "t" + string(rune('a'+i)), RequestID: id, TraceID: id,
				ServerLabel: "github", ToolName: "x", Source: "call", IsMCP: true, CreatedAt: base.Add(offset),
			})
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mk("t1", 100, 10, 1, 200, 0)
	mk("t2", 250, 20, 2, 200, time.Second)
	mk("t3", 50, 5, 0, 500, 2*time.Second)

	tl, err := db.SessionTimeline(ctx, "sess-x", 100)
	if err != nil {
		t.Fatal(err)
	}
	if tl.Requests != 3 {
		t.Fatalf("expected 3 turns, got %d", tl.Requests)
	}
	if tl.TotalCostKRW != 400 || tl.TotalTokens != 35 {
		t.Fatalf("unexpected totals: cost=%.0f tokens=%d", tl.TotalCostKRW, tl.TotalTokens)
	}
	if tl.ToolCalls != 3 {
		t.Fatalf("expected 3 tool calls, got %d", tl.ToolCalls)
	}
	// cumulative must be monotonic and ordered by time
	if tl.Points[0].CumulativeCostKRW != 100 || tl.Points[1].CumulativeCostKRW != 350 || tl.Points[2].CumulativeCostKRW != 400 {
		t.Fatalf("cumulative cost wrong: %v %v %v",
			tl.Points[0].CumulativeCostKRW, tl.Points[1].CumulativeCostKRW, tl.Points[2].CumulativeCostKRW)
	}
	if tl.Points[2].StatusCode != 500 {
		t.Fatalf("expected last turn status 500, got %d", tl.Points[2].StatusCode)
	}
	if tl.DurationSeconds != 2 {
		t.Fatalf("expected 2s duration, got %d", tl.DurationSeconds)
	}
}

func TestSessionTimelineEndpoint(t *testing.T) {
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

	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		id := "se-" + string(rune('a'+i))
		_ = db.InsertLogRecord(context.Background(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, SessionID: "s-ep", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now.Add(time.Duration(i) * time.Second)},
			Usage:   &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: 10, Currency: "KRW", Source: "usage", CreatedAt: now.Add(time.Duration(i) * time.Second)},
		})
	}

	// missing session_id → 400
	bad, _ := http.Get(proxy.URL + "/admin/llm/session")
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without session_id, got %d", bad.StatusCode)
	}
	bad.Body.Close()

	resp, err := http.Get(proxy.URL + "/admin/llm/session?session_id=s-ep")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var tl store.SessionTimeline
	if err := json.NewDecoder(resp.Body).Decode(&tl); err != nil {
		t.Fatal(err)
	}
	if tl.Requests != 3 || tl.TotalCostKRW != 30 {
		t.Fatalf("unexpected timeline: requests=%d cost=%.0f", tl.Requests, tl.TotalCostKRW)
	}
	if len(tl.Points) != 3 || tl.Points[2].CumulativeCostKRW != 30 {
		t.Fatalf("unexpected points: %#v", tl.Points)
	}
}
