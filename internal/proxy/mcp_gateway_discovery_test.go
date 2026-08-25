package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// mcpStub is a minimal MCP upstream that answers initialize and tools/list, optionally
// after a delay, so discovery timing can be measured.
func mcpStub(t *testing.T, name string, delay time.Duration, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.ID == nil {
			w.WriteHeader(http.StatusAccepted) // notification
			return
		}
		if calls != nil {
			calls.Add(1)
		}
		if delay > 0 {
			time.Sleep(delay)
		}
		var result string
		switch req.Method {
		case "initialize":
			result = `{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"` + name + `","version":"1"}}`
		case "tools/list":
			result = `{"tools":[{"name":"` + name + `_tool","description":"from ` + name + `","inputSchema":{"type":"object"}}]}`
		default:
			result = `{}`
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":%s}`, result)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func mcpDiscoveryServer(t *testing.T) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://unused.invalid", "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

// Discovery used to run one upstream after another, so its cost was the SUM of the
// upstreams. On a cold cache that runs synchronously on the first /mcp request, and the
// background refresh only has a 45s budget — so past a few slow upstreams the tail was
// never discovered at all. Concurrent discovery must cost about one upstream, not N.
func TestMCPDiscoveryQueriesUpstreamsConcurrently(t *testing.T) {
	const delay = 200 * time.Millisecond

	// Each upstream costs a fixed chain of calls (initialize, tools, resources,
	// templates, prompts) that is serial within that upstream no matter what. So the
	// property to assert is not an absolute duration but that adding upstreams does not
	// multiply the time: measure one upstream, then five, and compare.
	measure := func(count int) time.Duration {
		t.Helper()
		server, db := mcpDiscoveryServer(t)
		ctx := context.Background()
		for i := 0; i < count; i++ {
			name := fmt.Sprintf("up%d", i)
			stub := mcpStub(t, name, delay, nil)
			if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{
				ID: name, Name: name, URL: stub.URL, Enabled: true,
			}); err != nil {
				t.Fatal(err)
			}
		}
		start := time.Now()
		snap := server.buildMCPToolsSnapshot(ctx)
		elapsed := time.Since(start)
		if len(snap.tools) != count {
			t.Fatalf("discovered %d tools from %d upstreams: %v", len(snap.tools), count, snap.errors)
		}
		return elapsed
	}

	one := measure(1)
	five := measure(5)
	t.Logf("1 upstream: %v · 5 upstreams: %v (sequential would be ~5x)", one, five)

	// Concurrent discovery costs about one upstream's chain regardless of count.
	// Sequential would be ~5x. Allow generous slack for scheduling on a busy CI box
	// while still failing loudly if the work is serialized.
	if five > one*3 {
		t.Fatalf("5 upstreams took %v against %v for one — upstreams are queried sequentially, "+
			"so cost grows with count", five, one)
	}
}

// Parallel fetching must not change the result. Resource URI collisions are resolved by
// "first upstream wins", which has to follow registration order rather than whichever
// network call happened to return first.
func TestMCPDiscoveryResultIsOrderIndependent(t *testing.T) {
	server, db := mcpDiscoveryServer(t)
	ctx := context.Background()

	// Deliberately give the alphabetically-first upstream the slowest response, so a
	// naive implementation that merged on completion would order them the other way.
	for _, spec := range []struct {
		name  string
		delay time.Duration
	}{{"aaa", 250 * time.Millisecond}, {"bbb", 120 * time.Millisecond}, {"ccc", 0}} {
		stub := mcpStub(t, spec.name, spec.delay, nil)
		if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{
			ID: spec.name, Name: spec.name, URL: stub.URL, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	first := server.buildMCPToolsSnapshot(ctx)
	second := server.buildMCPToolsSnapshot(ctx)

	if len(first.tools) != 3 || len(second.tools) != 3 {
		t.Fatalf("expected 3 tools each time, got %d and %d (errors: %v)", len(first.tools), len(second.tools), first.errors)
	}
	for i := range first.tools {
		if first.tools[i].Name != second.tools[i].Name {
			t.Fatalf("repeated discovery produced a different order: %v vs %v",
				discoveredToolNames(first.tools), discoveredToolNames(second.tools))
		}
	}
	// Every tool must still resolve back to the upstream that advertised it.
	for _, tool := range first.tools {
		route, ok := first.routes[tool.Name]
		if !ok {
			t.Fatalf("tool %q has no route back to an upstream", tool.Name)
		}
		if route.upstreamID == "" || route.bareTool == "" {
			t.Fatalf("tool %q has an incomplete route: %+v", tool.Name, route)
		}
	}
}

// One dead upstream must not hide the others: failures are recorded per upstream and the
// rest of the catalogue is still served.
func TestMCPDiscoveryIsolatesAFailingUpstream(t *testing.T) {
	server, db := mcpDiscoveryServer(t)
	ctx := context.Background()

	healthy := mcpStub(t, "healthy", 0, nil)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer dead.Close()

	for _, spec := range []struct{ id, url string }{{"healthy", healthy.URL}, {"zdead", dead.URL}} {
		if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{
			ID: spec.id, Name: spec.id, URL: spec.url, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	snap := server.buildMCPToolsSnapshot(ctx)
	if len(snap.tools) != 1 {
		t.Fatalf("a failing upstream suppressed the healthy catalogue: %d tools", len(snap.tools))
	}
	if _, reported := snap.errors["zdead"]; !reported {
		t.Fatalf("the failing upstream was not reported to operators: %v", snap.errors)
	}
	if _, reported := snap.errors["healthy"]; reported {
		t.Fatalf("the healthy upstream was wrongly reported as failing: %v", snap.errors)
	}
}

func discoveredToolNames(tools []mcpToolDef) []string {
	out := make([]string, 0, len(tools))
	for _, t := range tools {
		out = append(out, t.Name)
	}
	return out
}
