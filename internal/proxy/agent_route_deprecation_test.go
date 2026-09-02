package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

type agentRouteDeprecationFixture struct {
	server  *Server
	db      *store.SQLStore
	gateway *httptest.Server
	logger  *store.AsyncLogger

	modelsMu sync.Mutex
	models   []string
}

func newAgentRouteDeprecationFixture(t *testing.T) *agentRouteDeprecationFixture {
	t.Helper()
	fixture := &agentRouteDeprecationFixture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		fixture.modelsMu.Lock()
		fixture.models = append(fixture.models, payload.Model)
		fixture.modelsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"agent-deprecation","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "agent-route-deprecation.ndjson"))
	logger.Start()
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		upstream.Close()
		logger.Stop(context.Background())
		db.Close()
		t.Fatal(err)
	}
	fixture.server = server
	fixture.db = db
	fixture.logger = logger
	fixture.gateway = httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		fixture.gateway.Close()
		upstream.Close()
		logger.Stop(context.Background())
		db.Close()
	})
	return fixture
}

func (f *agentRouteDeprecationFixture) addRoute(t *testing.T, id, virtualModel, backingModel string) {
	t.Helper()
	if err := f.db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: id, VirtualModel: virtualModel, Name: virtualModel, Enabled: true,
		BackingModel: backingModel, Provider: "test", MaxSteps: 1,
	}); err != nil {
		t.Fatal(err)
	}
}

func (f *agentRouteDeprecationFixture) addDeprecation(t *testing.T, model, replacement, sunset, message string) {
	t.Helper()
	if _, err := f.db.UpsertModelDeprecation(t.Context(), store.ModelDeprecation{
		ModelGlob: model, Replacement: replacement, SunsetDate: sunset, Message: message,
	}); err != nil {
		t.Fatal(err)
	}
	f.server.invalidateDeprecationCache()
}

func (f *agentRouteDeprecationFixture) chat(t *testing.T, model, token string) *http.Response {
	t.Helper()
	return postJSON(t, f.gateway.URL+"/v1/chat/completions", token, map[string]any{
		"model": model, "messages": []map[string]string{{"role": "user", "content": "hello"}},
	})
}

func (f *agentRouteDeprecationFixture) upstreamModels() []string {
	f.modelsMu.Lock()
	defer f.modelsMu.Unlock()
	return append([]string(nil), f.models...)
}

func (f *agentRouteDeprecationFixture) latestRequest(t *testing.T) store.RecentRequest {
	t.Helper()
	waitFor(t, 2*time.Second, func() bool {
		return f.logger.Written() >= 1
	})
	rows, err := f.db.RecentRequests(context.Background(), store.RequestFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("request audit count = %d, want exactly 1: %+v", len(rows), rows)
	}
	detail, err := f.db.RequestDetail(context.Background(), rows[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	return detail.Request
}

func TestAgentRouteDeprecationWarnsBeforeRunningRoute(t *testing.T) {
	f := newAgentRouteDeprecationFixture(t)
	f.addRoute(t, "route-warn", "vibe/agent-warn", "gpt-warn")
	f.addDeprecation(t, "vibe/agent-warn", "vibe/agent-next", "", "use the next route")

	resp := f.chat(t, "vibe/agent-warn", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("warn-only route status = %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Model-Deprecated"); got != "vibe/agent-warn" {
		t.Fatalf("deprecated header = %q", got)
	}
	if got := resp.Header.Get("X-Model-Replacement"); got != "vibe/agent-next" {
		t.Fatalf("replacement header = %q", got)
	}
	if got := resp.Header.Get("X-Model-Deprecation-Message"); got != "use the next route" {
		t.Fatalf("message header = %q", got)
	}
	if got := resp.Header.Get("X-Model-Sunset-Rewritten"); got != "" {
		t.Fatalf("warn-only route was rewritten to %q", got)
	}
	if got := f.upstreamModels(); len(got) != 1 || got[0] != "gpt-warn" {
		t.Fatalf("warn-only backing calls = %v", got)
	}
	if got := f.server.metrics.modelSunsetRewrite.Load(); got != 0 {
		t.Fatalf("rewrite metric = %d, want 0", got)
	}
}

func TestAgentRouteDeprecationBlocksRetiredRoute(t *testing.T) {
	f := newAgentRouteDeprecationFixture(t)
	f.addRoute(t, "route-dead", "vibe/agent-dead", "gpt-dead")
	f.addDeprecation(t, "vibe/agent-dead", "", "2000-01-01", "retired")

	resp := f.chat(t, "vibe/agent-dead", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("retired route status = %d, want 400: %s", resp.StatusCode, body)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "model_sunset" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
	if got := f.server.metrics.modelSunsetBlock.Load(); got != 1 {
		t.Fatalf("block metric = %d, want 1", got)
	}
	if got := f.upstreamModels(); len(got) != 0 {
		t.Fatalf("retired route reached upstream with %v", got)
	}
	request := f.latestRequest(t)
	if request.Model != "vibe/agent-dead" || request.StatusCode != http.StatusBadRequest {
		t.Fatalf("blocked request audit = %+v", request)
	}
}

func TestAgentRouteDeprecationRewritesOnceToReplacementRoute(t *testing.T) {
	f := newAgentRouteDeprecationFixture(t)
	f.addRoute(t, "route-old", "vibe/agent-old", "gpt-old")
	f.addRoute(t, "route-next", "vibe/agent-next", "gpt-next")
	f.addDeprecation(t, "vibe/agent-old", "vibe/agent-next", "2000-01-01", "migrated")
	// A second rule points back to the original. One request must apply only the
	// first transition rather than recurse through an A↔B cycle.
	f.addDeprecation(t, "vibe/agent-next", "vibe/agent-old", "2000-01-01", "cycle")

	resp := f.chat(t, "vibe/agent-old", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("replacement route status = %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Model-Sunset-Rewritten"); got != "vibe/agent-next" {
		t.Fatalf("rewrite header = %q", got)
	}
	if got := resp.Header.Get("X-Agent-Route"); got != "vibe/agent-next" {
		t.Fatalf("replacement agent route = %q", got)
	}
	if got := f.upstreamModels(); len(got) != 1 || got[0] != "gpt-next" {
		t.Fatalf("replacement backing calls = %v", got)
	}
	if got := f.server.metrics.modelSunsetRewrite.Load(); got != 1 {
		t.Fatalf("rewrite metric = %d, want 1", got)
	}
	request := f.latestRequest(t)
	if request.RequestedModel != "vibe/agent-old" || request.Model != "vibe/agent-next" ||
		request.ResolvedModel != "vibe/agent-next" || request.UpstreamModel != "gpt-next" ||
		!strings.HasPrefix(request.RouteDetail, "vibe/agent-next") {
		t.Fatalf("replacement route audit = %+v", request)
	}
}

func TestAgentRouteDeprecationContinuesWithPhysicalReplacementOnce(t *testing.T) {
	f := newAgentRouteDeprecationFixture(t)
	f.addRoute(t, "route-physical", "vibe/agent-physical", "gpt-unused")
	f.addDeprecation(t, "vibe/agent-physical", "physical-successor", "2000-01-01", "migrated")
	f.addDeprecation(t, "physical-successor", "double-rewrite", "2000-01-01", "do not chain")

	resp := f.chat(t, "vibe/agent-physical", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("physical replacement status = %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Model-Sunset-Rewritten"); got != "physical-successor" {
		t.Fatalf("rewrite header = %q", got)
	}
	if got := resp.Header.Get("X-Agent-Route"); got != "" {
		t.Fatalf("physical replacement unexpectedly used agent route %q", got)
	}
	if got := f.upstreamModels(); len(got) != 1 || got[0] != "physical-successor" {
		t.Fatalf("physical replacement calls = %v", got)
	}
	if got := f.server.metrics.modelSunsetRewrite.Load(); got != 1 {
		t.Fatalf("rewrite metric = %d, want one-hop count 1", got)
	}
	request := f.latestRequest(t)
	if request.RequestedModel != "vibe/agent-physical" || request.Model != "physical-successor" ||
		request.ResolvedModel != "physical-successor" || request.UpstreamModel != "physical-successor" {
		t.Fatalf("physical replacement audit = %+v", request)
	}
}

func TestAgentRouteDeprecationRechecksReplacementRBAC(t *testing.T) {
	f := newAgentRouteDeprecationFixture(t)
	f.addRoute(t, "route-allowed", "vibe/agent-allowed", "gpt-allowed")
	f.addRoute(t, "route-denied", "vibe/agent-denied", "gpt-denied")
	f.addDeprecation(t, "vibe/agent-allowed", "vibe/agent-denied", "2000-01-01", "restricted migration")

	const token = "vc_sk_agent_deprecation"
	if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "key-agent-deprecation", Name: "agent-deprecation", KeyHash: hashProxyKey(token), Status: "active",
		Scopes: []string{"chat:completion"}, AllowedModels: []string{"vibe/agent-allowed"},
	}); err != nil {
		t.Fatal(err)
	}

	resp := f.chat(t, "vibe/agent-allowed", token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("replacement RBAC status = %d, want 403: %s", resp.StatusCode, body)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "model_denied" {
		t.Fatalf("RBAC error code = %q", body.Error.Code)
	}
	if got := resp.Header.Get("X-Model-Sunset-Rewritten"); got != "" {
		t.Fatalf("denied replacement was counted/applied as rewrite to %q", got)
	}
	if got := f.server.metrics.modelSunsetRewrite.Load(); got != 0 {
		t.Fatalf("denied replacement rewrite metric = %d", got)
	}
	if got := f.upstreamModels(); len(got) != 0 {
		t.Fatalf("denied replacement reached upstream with %v", got)
	}
	request := f.latestRequest(t)
	if request.Model != "vibe/agent-allowed" || request.StatusCode != http.StatusForbidden {
		t.Fatalf("replacement denial audit = %+v", request)
	}
}
