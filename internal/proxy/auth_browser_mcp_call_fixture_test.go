//go:build linux

package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

// Only isolated in-process upstreams are contacted by the browser harness.
func seedBrowserMcpCallFixture(t *testing.T, db *store.SQLStore) func() {
	t.Helper()
	fake := fakeMCPUpstream(t)
	t.Cleanup(fake.Close)
	var calls atomic.Int32
	var invalid atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32768))
		r.Body.Close()
		if err != nil {
			invalid.Store(true)
			w.WriteHeader(400)
			return
		}
		var message struct {
			Method string `json:"method"`
			Params struct {
				Name      string `json:"name"`
				Arguments struct {
					Text string `json:"text"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(body, &message) != nil {
			invalid.Store(true)
			w.WriteHeader(400)
			return
		}
		if message.Method == "tools/call" {
			calls.Add(1)
			if message.Params.Name != "echo" || message.Params.Arguments.Text != "browser reviewed" {
				invalid.Store(true)
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		fake.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "browser-call", Name: "호출 검증 서버", URL: upstream.URL, Enabled: true}); err != nil {
		t.Fatal("MCP call fixture could not be seeded")
	}
	if err := db.UpsertToolRiskProfile(t.Context(), store.ToolRiskProfile{ID: "browser_call_profile", ServerLabel: "호출 검증 서버", ToolName: "echo", RiskLevel: "low", Action: "allow"}); err != nil {
		t.Fatal("MCP call risk fixture could not be seeded")
	}
	return func() {
		if calls.Load() != 1 || invalid.Load() {
			t.Fatal("reviewed MCP call must reach the isolated upstream exactly once with the reviewed arguments")
		}
	}
}
