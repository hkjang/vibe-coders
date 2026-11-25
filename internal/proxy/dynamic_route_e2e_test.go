package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

// fakeModelUpstream answers chat completions and remembers what it was asked.
// behaviour maps a model to a status code; unlisted models answer 200.
type fakeModelUpstream struct {
	mu        sync.Mutex
	models    []string
	headers   []http.Header
	behaviour map[string][]int
	delay     map[string]time.Duration
	server    *httptest.Server
}

func newFakeModelUpstream(t *testing.T) *fakeModelUpstream {
	t.Helper()
	fake := &fakeModelUpstream{behaviour: map[string][]int{}, delay: map[string]time.Duration{}}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		model := extractModel(body)
		fake.mu.Lock()
		fake.models = append(fake.models, model)
		fake.headers = append(fake.headers, r.Header.Clone())
		status := http.StatusOK
		if queue := fake.behaviour[model]; len(queue) > 0 {
			status = queue[0]
			if len(queue) > 1 {
				fake.behaviour[model] = queue[1:]
			}
		}
		delay := fake.delay[model]
		fake.mu.Unlock()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = io.WriteString(w, `{"error":{"message":"upstream says no","type":"server_error"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"`+model+`","choices":[{"index":0,"message":{"role":"assistant","content":"ok from `+model+`"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeModelUpstream) set(model string, statuses ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.behaviour[model] = statuses
}

func (f *fakeModelUpstream) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.models...)
}

func (f *fakeModelUpstream) lastHeaders() http.Header {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.headers) == 0 {
		return nil
	}
	return f.headers[len(f.headers)-1]
}

type dynamicRouteEnv struct {
	url     string
	db      *store.SQLStore
	server  *Server
	primary *fakeModelUpstream
	backup  *fakeModelUpstream
}

// newDynamicRouteEnv runs the real gateway with two providers: the default "test"
// provider and a second provider named "backup", each backed by its own fake.
func newDynamicRouteEnv(t *testing.T, mutate func(*config.Config)) *dynamicRouteEnv {
	t.Helper()
	primary, backup := newFakeModelUpstream(t), newFakeModelUpstream(t)
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	cfg := testConfig(primary.server.URL, "primary-key")
	if mutate != nil {
		mutate(&cfg)
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := secret.New(cfg.Secret.GatewaySecret)
	if err != nil {
		t.Fatal(err)
	}
	key, err := cipher.Encrypt("backup-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
		Name: "backup", BaseURL: backup.server.URL, EncryptedAPIKey: key, TimeoutMS: 5000, Enabled: true, Priority: 100,
	}); err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return &dynamicRouteEnv{url: proxy.URL, db: db, server: server, primary: primary, backup: backup}
}

func (e *dynamicRouteEnv) do(t *testing.T, method, path string, body any, headers ...string) (*http.Response, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.url+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func (e *dynamicRouteEnv) chat(t *testing.T, model string, headers ...string) (*http.Response, []byte) {
	t.Helper()
	return e.do(t, http.MethodPost, "/v1/chat/completions", chatBody(model, false), headers...)
}

func decodeJSONMap(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("response is not JSON: %v: %s", err, data)
	}
	return out
}

func (e *dynamicRouteEnv) createRoute(t *testing.T, name, graph string, deploy bool) string {
	t.Helper()
	resp, data := e.do(t, http.MethodPost, dynamicRoutesAdminPath, map[string]any{
		"name": name, "graph": json.RawMessage(graph), "note": "first", "deploy": deploy,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create route: %d %s", resp.StatusCode, data)
	}
	route := decodeJSONMap(t, data)["route"].(map[string]any)
	return route["id"].(string)
}

func (e *dynamicRouteEnv) routeRequests(t *testing.T, routeID string, n int) []store.DynamicRouteRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows, err := e.db.ListDynamicRouteRequests(context.Background(), routeID, 50)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) >= n || time.Now().After(deadline) {
			if len(rows) < n {
				t.Fatalf("expected %d dynamic route records, got %d", n, len(rows))
			}
			return rows
		}
		time.Sleep(10 * time.Millisecond)
	}
}

const e2eRouteGraph = `{"elements":[
  {"id":"start","type":"start","outputs":{"next":{"elementId":"plan"}}},
  {"id":"plan","type":"conditional","properties":{"conditions":{"metadata.plan":"free"}},"outputs":{"true":{"elementId":"cheap"},"false":{"elementId":"primary"}}},
  {"id":"primary","type":"model","properties":{"provider":"test","model":"primary-model","retries":1},"outputs":{"success":{"elementId":"end"},"fallback":{"elementId":"rescue"}}},
  {"id":"rescue","type":"model","properties":{"provider":"backup","model":"rescue-model"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"cheap","type":"model","properties":{"provider":"backup","model":"cheap-model"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"end","type":"end"}]}`

func TestDynamicRouteServesConditionsAndFallbacksEndToEnd(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	routeID := env.createRoute(t, "support", e2eRouteGraph, false)

	// Saved but not deployed: the route serves nothing yet.
	resp, data := env.chat(t, "dynamic/support")
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(data), "dynamic_route_not_found") {
		t.Fatalf("undeployed route should be unknown: %d %s", resp.StatusCode, data)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/deploy", map[string]any{"version": 1, "expected_deployed_version": 0})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deploy: %d %s", resp.StatusCode, data)
	}

	// Metadata decides the branch; the gateway sends the concrete model and never
	// forwards the control header.
	resp, data = env.chat(t, "dynamic/support", "X-Vibe-Metadata", `{"plan":"free","user":"kim@example.com"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("free plan request: %d %s", resp.StatusCode, data)
	}
	if got := env.backup.calls(); len(got) != 1 || got[0] != "cheap-model" {
		t.Fatalf("free plan should reach cheap-model on backup: %v", got)
	}
	if env.backup.lastHeaders().Get("X-Vibe-Metadata") != "" {
		t.Fatal("the metadata control header leaked to the provider")
	}
	if path := resp.Header.Get("X-Dynamic-Route-Path"); path != "start>plan:true>cheap:success>end" {
		t.Fatalf("path header = %q", path)
	}
	if resp.Header.Get("X-Dynamic-Route") != "support" || resp.Header.Get("X-Dynamic-Route-Version") != "1" || resp.Header.Get("X-Routed-Model") != "cheap-model" {
		t.Fatalf("route headers missing: %v", resp.Header)
	}

	// Paid traffic: the pinned primary fails twice (one retry), then the graph's
	// fallback answers from the other provider.
	env.primary.set("primary-model", http.StatusInternalServerError, http.StatusInternalServerError)
	resp, data = env.chat(t, "dynamic/support", "cf-aig-metadata", `{"plan":"pro"}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(data), "ok from rescue-model") {
		t.Fatalf("fallback request: %d %s", resp.StatusCode, data)
	}
	if got := env.primary.calls(); len(got) != 2 || got[0] != "primary-model" || got[1] != "primary-model" {
		t.Fatalf("primary should be tried twice: %v", got)
	}
	if resp.Header.Get("X-Upstream-Retries") != "1" {
		t.Fatalf("retry count header = %q", resp.Header.Get("X-Upstream-Retries"))
	}
	if path := resp.Header.Get("X-Dynamic-Route-Path"); path != "start>plan:false>primary:failed>rescue:success>end" {
		t.Fatalf("fallback path header = %q", path)
	}

	rows := env.routeRequests(t, routeID, 2)
	fallback := rows[0]
	if fallback.FinalElementID != "rescue" || fallback.Fallbacks != 1 || fallback.Attempts != 2 || fallback.Outcome != "success" || fallback.Version != 1 {
		t.Fatalf("fallback record wrong: %+v", fallback)
	}
	free := rows[1]
	if strings.Contains(free.MetadataJSON, "kim@example.com") || !strings.Contains(free.MetadataJSON, `"plan":"free"`) {
		t.Fatalf("stored metadata must keep tags and mask personal data: %s", free.MetadataJSON)
	}

	// The request log names the virtual model the client asked for.
	var detail store.RequestDetail
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		detail, err = env.db.RequestDetail(context.Background(), fallback.RequestID)
		if err == nil || time.Now().After(deadline) {
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if detail.Request.RequestedModel != "dynamic/support" || detail.Request.RouteReason != "dynamic_route" || !detail.Request.Failover {
		t.Fatalf("request log does not describe the route: requested=%q reason=%q failover=%v", detail.Request.RequestedModel, detail.Request.RouteReason, detail.Request.Failover)
	}
	if detail.Readability == nil || detail.Readability.Routing["dynamic_route"] == nil {
		t.Fatalf("routing summary lost the dynamic route section: %+v", detail.Readability)
	}

	// A provider-side 400 is the request's fault: no fallback.
	env.primary.set("primary-model", http.StatusBadRequest)
	resp, _ = env.chat(t, "dynamic/support")
	if resp.StatusCode != http.StatusBadRequest || resp.Header.Get("X-Dynamic-Route-Path") != "start>plan:false>primary:success>end" {
		t.Fatalf("400 should be returned as is: %d path=%q", resp.StatusCode, resp.Header.Get("X-Dynamic-Route-Path"))
	}
}

func TestDynamicRouteVersionsDeployAndRollBack(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	graphFor := func(model string) string {
		return `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"m"}}},
		  {"id":"m","type":"model","properties":{"provider":"backup","model":"` + model + `"},"outputs":{"success":{"elementId":"e"}}},
		  {"id":"e","type":"end"}]}`
	}
	routeID := env.createRoute(t, "Canary", graphFor("model-v1"), true)
	if _, data := env.chat(t, "dynamic/canary"); !strings.Contains(string(data), "model-v1") {
		t.Fatalf("v1 not served (names are case-insensitive): %s", data)
	}

	// A save on a stale base is refused instead of overwriting.
	resp, data := env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/versions", map[string]any{"base_version": 1, "graph": json.RawMessage(graphFor("model-v2")), "note": "v2"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("save v2: %d %s", resp.StatusCode, data)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/versions", map[string]any{"base_version": 1, "graph": json.RawMessage(graphFor("model-x"))})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale save should conflict: %d %s", resp.StatusCode, data)
	}
	// Saving does not change what is served.
	if _, data := env.chat(t, "dynamic/canary"); !strings.Contains(string(data), "model-v1") {
		t.Fatalf("an undeployed save changed live traffic: %s", data)
	}
	resp, data = env.do(t, http.MethodGet, dynamicRoutesAdminPath+"/"+routeID, nil)
	detail := decodeJSONMap(t, data)
	if detail["route"].(map[string]any)["state"] != "live_with_draft" {
		t.Fatalf("route should report a pending draft: %s", data)
	}

	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/deploy", map[string]any{"version": 2, "expected_deployed_version": 1})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deploy v2: %d %s", resp.StatusCode, data)
	}
	if _, data := env.chat(t, "dynamic/canary"); !strings.Contains(string(data), "model-v2") {
		t.Fatalf("v2 not served after deploy: %s", data)
	}
	// A deploy from a stale screen is refused.
	resp, _ = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/deploy", map[string]any{"version": 1, "expected_deployed_version": 1})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale deploy should conflict: %d", resp.StatusCode)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/"+routeID+"/deploy", map[string]any{"version": 1, "expected_deployed_version": 2, "reason": "v2 regressed"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rollback: %d %s", resp.StatusCode, data)
	}
	if _, data := env.chat(t, "dynamic/canary"); !strings.Contains(string(data), "model-v1") {
		t.Fatalf("rollback did not take effect: %s", data)
	}

	// Disabling refuses calls without deleting anything.
	resp, _ = env.do(t, http.MethodPatch, dynamicRoutesAdminPath+"/"+routeID, map[string]any{"enabled": false})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable: %d", resp.StatusCode)
	}
	if resp, data := env.chat(t, "dynamic/canary"); resp.StatusCode != http.StatusNotFound || !strings.Contains(string(data), "dynamic_route_disabled") {
		t.Fatalf("disabled route served: %d %s", resp.StatusCode, data)
	}
	resp, data = env.do(t, http.MethodGet, dynamicRoutesAdminPath+"/"+routeID+"/versions/2", nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(data), "model-v2") {
		t.Fatalf("version read: %d %s", resp.StatusCode, data)
	}
}

func TestDynamicRouteRateLimitRefusesWithoutFallback(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	graph := `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"cap"}}},
	  {"id":"cap","type":"rate","properties":{"limitType":"count","key":"identity.api_key_id","limit":1,"window":3600},"outputs":{"success":{"elementId":"m"}}},
	  {"id":"m","type":"model","properties":{"provider":"backup","model":"capped-model"},"outputs":{"success":{"elementId":"e"}}},
	  {"id":"e","type":"end"}]}`
	routeID := env.createRoute(t, "capped", graph, true)
	if resp, data := env.chat(t, "dynamic/capped"); resp.StatusCode != http.StatusOK {
		t.Fatalf("first call: %d %s", resp.StatusCode, data)
	}
	resp, data := env.chat(t, "dynamic/capped")
	if resp.StatusCode != http.StatusTooManyRequests || !strings.Contains(string(data), "dynamic_route_rate_limited") {
		t.Fatalf("second call should be limited: %d %s", resp.StatusCode, data)
	}
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err != nil || seconds < 1 || seconds > 3600 {
		t.Fatalf("Retry-After = %q", resp.Header.Get("Retry-After"))
	}
	if resp.Header.Get("X-Dynamic-Route-Limit") != "cap" || resp.Header.Get("X-Dynamic-Route-Path") != "s>cap:exceeded" {
		t.Fatalf("limit headers: %v", resp.Header)
	}
	if got := env.backup.calls(); len(got) != 1 {
		t.Fatalf("a limited request reached the provider: %v", got)
	}
	rows := env.routeRequests(t, routeID, 2)
	if rows[0].Outcome != "rate_limited" || rows[0].StatusCode != http.StatusTooManyRequests {
		t.Fatalf("limited request record: %+v", rows[0])
	}
	resp, data = env.do(t, http.MethodGet, dynamicRoutesAdminPath+"/"+routeID+"/activity", nil)
	activity := decodeJSONMap(t, data)
	if resp.StatusCode != http.StatusOK || len(activity["limits"].([]any)) != 1 || len(activity["requests"].([]any)) != 2 {
		t.Fatalf("activity view: %d %s", resp.StatusCode, data)
	}
}

func TestDynamicRouteRespectsKeyModelPolicy(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	env.createRoute(t, "policy", e2eRouteGraph, true)
	key := createDynamicRouteTestKey(t, env, "denyprimary", []string{"primary-model"})
	// The denied primary is skipped as if it had failed; its fallback serves.
	resp, data := env.chat(t, "dynamic/policy", "Authorization", "Bearer "+key)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(data), "ok from rescue-model") {
		t.Fatalf("denied model should be skipped to its fallback: %d %s", resp.StatusCode, data)
	}
	if path := resp.Header.Get("X-Dynamic-Route-Path"); path != "start>plan:false>primary:skipped>rescue:success>end" {
		t.Fatalf("path = %q", path)
	}
	if len(env.primary.calls()) != 0 {
		t.Fatal("a model the key may not use was called")
	}
	// Denying the virtual model itself refuses the route.
	blocked := createDynamicRouteTestKey(t, env, "denydynamic", []string{"dynamic/*"})
	if resp, _ := env.chat(t, "dynamic/policy", "Authorization", "Bearer "+blocked); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("denied virtual model served: %d", resp.StatusCode)
	}
}

func createDynamicRouteTestKey(t *testing.T, env *dynamicRouteEnv, name string, denied []string) string {
	t.Helper()
	token := "vc_sk_synthetic_" + name
	if err := env.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: name, Name: name, KeyHash: hashProxyKey(token), Role: "developer", Status: "active",
		Scopes: []string{"chat:completion"}, DeniedModels: denied,
	}); err != nil {
		t.Fatal(err)
	}
	return token
}

func TestDynamicRouteSimulateAndValidateEndpoints(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	resp, data := env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/simulate", map[string]any{
		"graph": json.RawMessage(e2eRouteGraph), "metadata": map[string]any{"plan": "pro"}, "failing": []string{"primary"}, "samples": 200,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("simulate: %d %s", resp.StatusCode, data)
	}
	result := decodeJSONMap(t, data)["result"].(map[string]any)
	if result["final_element_id"] != "rescue" || result["path"] != "start>plan:false>primary:failed>rescue:success>end" {
		t.Fatalf("simulation result: %v", result)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath+"/validate", map[string]any{
		"graph": json.RawMessage(`{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"m"}}},{"id":"m","type":"model","properties":{"provider":"nobody","model":"x"}}]}`),
	})
	validation := decodeJSONMap(t, data)
	if resp.StatusCode != http.StatusOK || validation["valid"] != true || !strings.Contains(string(data), "provider_not_found") {
		t.Fatalf("validate should accept with a provider warning: %d %s", resp.StatusCode, data)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath, map[string]any{"name": "Bad Name!", "graph": json.RawMessage(e2eRouteGraph)})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid name accepted: %d %s", resp.StatusCode, data)
	}
	resp, data = env.do(t, http.MethodPost, dynamicRoutesAdminPath, map[string]any{"name": "broken", "graph": json.RawMessage(`{"elements":[{"id":"s","type":"start"}]}`)})
	if resp.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(data), "start_next_missing") {
		t.Fatalf("broken graph accepted: %d %s", resp.StatusCode, data)
	}
	env.createRoute(t, "dup", e2eRouteGraph, false)
	resp, _ = env.do(t, http.MethodPost, dynamicRoutesAdminPath, map[string]any{"name": "dup", "graph": json.RawMessage(e2eRouteGraph)})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate name accepted: %d", resp.StatusCode)
	}
	// Agent routes cannot claim the dynamic namespace.
	resp, _ = env.do(t, http.MethodPost, "/admin/agent-routes", map[string]any{"virtual_model": "dynamic/dup"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("agent route took the dynamic namespace: %d", resp.StatusCode)
	}
}

func TestRequestControlsRetryTimeoutAndValidate(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	// Two failures, then success: three tries on one provider.
	env.primary.set("test-model", http.StatusServiceUnavailable, http.StatusServiceUnavailable, http.StatusOK)
	resp, data := env.chat(t, "test-model", "X-Vibe-Max-Attempts", "3", "X-Vibe-Retry-Delay", "5", "X-Vibe-Backoff", "exponential")
	if resp.StatusCode != http.StatusOK || len(env.primary.calls()) != 3 || resp.Header.Get("X-Upstream-Retries") != "2" {
		t.Fatalf("retries: status=%d calls=%v retries=%q %s", resp.StatusCode, env.primary.calls(), resp.Header.Get("X-Upstream-Retries"), data)
	}
	if env.primary.lastHeaders().Get("X-Vibe-Max-Attempts") != "" || env.primary.lastHeaders().Get("Cf-Aig-Backoff") != "" {
		t.Fatal("request control headers leaked to the provider")
	}
	// Without the header a 503 is returned after one try, as before.
	env.primary.set("test-model", http.StatusServiceUnavailable)
	before := len(env.primary.calls())
	if resp, _ := env.chat(t, "test-model"); resp.StatusCode != http.StatusServiceUnavailable || len(env.primary.calls()) != before+1 {
		t.Fatalf("default should not retry: %d calls=%d", resp.StatusCode, len(env.primary.calls())-before)
	}
	// A per-try timeout waits for headers only that long.
	env.primary.set("slow-model")
	env.primary.mu.Lock()
	env.primary.delay["slow-model"] = 2 * time.Second
	env.primary.mu.Unlock()
	started := time.Now()
	resp, data = env.chat(t, "slow-model", "cf-aig-request-timeout", "100")
	if resp.StatusCode != http.StatusGatewayTimeout || time.Since(started) > 1500*time.Millisecond {
		t.Fatalf("request timeout: %d after %s %s", resp.StatusCode, time.Since(started), data)
	}
	for _, bad := range [][]string{{"X-Vibe-Max-Attempts", "9"}, {"X-Vibe-Backoff", "random"}, {"X-Vibe-Metadata", `{"nested":{"a":1}}`}, {"cf-aig-request-timeout", "-1"}, {"X-Vibe-Metadata", "not json"}} {
		resp, data := env.chat(t, "test-model", bad...)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "invalid_request_control") {
			t.Fatalf("%v should be rejected: %d %s", bad, resp.StatusCode, data)
		}
	}
}

func TestRequestControlsCacheBypassAndStatus(t *testing.T) {
	env := newDynamicRouteEnv(t, func(cfg *config.Config) {
		cfg.Cache.ChatEnabled = true
		cfg.Cache.ChatTTL = time.Hour
		cfg.Cache.EmbeddingMaxBytes = 1 << 20
	})
	body := chatBody("test-model", false)
	body["temperature"] = 0
	first, _ := env.do(t, http.MethodPost, "/v1/chat/completions", body)
	second, _ := env.do(t, http.MethodPost, "/v1/chat/completions", body)
	bypass, _ := env.do(t, http.MethodPost, "/v1/chat/completions", body, "X-Vibe-Skip-Cache", "true")
	if first.Header.Get("X-Cache") != "MISS" || second.Header.Get("X-Cache") != "HIT" || bypass.Header.Get("X-Cache") != "BYPASS" {
		t.Fatalf("cache status: %q %q %q", first.Header.Get("X-Cache"), second.Header.Get("X-Cache"), bypass.Header.Get("X-Cache"))
	}
	if calls := env.primary.calls(); len(calls) != 2 {
		t.Fatalf("a bypass must reach the provider and a hit must not: %v", calls)
	}
	if cacheTTLFor(time.Hour, 2*time.Hour) != time.Hour || cacheTTLFor(time.Hour, time.Minute) != time.Minute || cacheTTLFor(time.Hour, 0) != time.Hour {
		t.Fatal("a caller may shorten the cache TTL but never extend it")
	}
}

func TestParseRequestControlsAliases(t *testing.T) {
	h := http.Header{}
	h.Set("cf-aig-max-attempts", "2")
	h.Set("X-Vibe-Max-Attempts", "4")
	h.Set("cf-aig-metadata", `{"team":"ml","n":3,"beta":true}`)
	h.Set("cf-aig-skip-cache", "1")
	controls, err := parseRequestControls(h)
	if err != nil {
		t.Fatal(err)
	}
	if controls.MaxAttempts != 4 {
		t.Fatalf("the X-Vibe name should win over the cf-aig alias: %d", controls.MaxAttempts)
	}
	if controls.Metadata["team"] != "ml" || controls.Metadata["n"] != float64(3) || controls.Metadata["beta"] != true || !controls.SkipCache {
		t.Fatalf("aliases not read: %+v", controls)
	}
	tooMany := map[string]any{}
	for i := 0; i <= requestMetadataMaxEntries; i++ {
		tooMany["k"+strconv.Itoa(i)] = i
	}
	raw, _ := json.Marshal(tooMany)
	if _, err := parseRequestMetadata(string(raw)); err == nil {
		t.Fatal("metadata above the entry limit accepted")
	}
}

func TestDynamicRouteCacheHitIsRecordedAndListed(t *testing.T) {
	env := newDynamicRouteEnv(t, func(cfg *config.Config) {
		cfg.Cache.ChatEnabled = true
		cfg.Cache.ChatTTL = time.Hour
		cfg.Cache.EmbeddingMaxBytes = 1 << 20
	})
	graph := `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"m"}}},
	  {"id":"m","type":"model","properties":{"provider":"backup","model":"cached-model"},"outputs":{"success":{"elementId":"e"}}},
	  {"id":"e","type":"end"}]}`
	routeID := env.createRoute(t, "cached", graph, true)
	body := chatBody("dynamic/cached", false)
	body["temperature"] = 0
	first, _ := env.do(t, http.MethodPost, "/v1/chat/completions", body)
	second, data := env.do(t, http.MethodPost, "/v1/chat/completions", body)
	if first.Header.Get("X-Cache") != "MISS" || second.Header.Get("X-Cache") != "HIT" || !strings.Contains(string(data), "cached-model") {
		t.Fatalf("route response should be cached: %q %q %s", first.Header.Get("X-Cache"), second.Header.Get("X-Cache"), data)
	}
	if path := second.Header.Get("X-Dynamic-Route-Path"); path != "s>m:cache_hit>e" {
		t.Fatalf("cache hit path = %q", path)
	}
	if calls := env.backup.calls(); len(calls) != 1 {
		t.Fatalf("a cache hit reached the provider: %v", calls)
	}
	rows := env.routeRequests(t, routeID, 2)
	if rows[0].Outcome != "cache_hit" || rows[1].Outcome != "success" {
		t.Fatalf("outcomes: %q %q", rows[0].Outcome, rows[1].Outcome)
	}

	resp, catalogue := env.do(t, http.MethodGet, "/v1/models", nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(catalogue), `"id":"dynamic/cached"`) {
		t.Fatalf("deployed route missing from /v1/models: %d %s", resp.StatusCode, catalogue)
	}
}

// An element whose provider cannot be used here — removed, disabled or denied to
// the key — is a failure of that element, not of the request.
func TestDynamicRouteFallsBackPastAnUnusableProvider(t *testing.T) {
	env := newDynamicRouteEnv(t, nil)
	graph := `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"gone"}}},
	  {"id":"gone","type":"model","properties":{"provider":"ghost","model":"ghost-model"},"outputs":{"success":{"elementId":"e"},"fallback":{"elementId":"denied"}}},
	  {"id":"denied","type":"model","properties":{"provider":"test","model":"primary-model"},"outputs":{"success":{"elementId":"e"},"fallback":{"elementId":"ok"}}},
	  {"id":"ok","type":"model","properties":{"provider":"backup","model":"rescue-model"},"outputs":{"success":{"elementId":"e"}}},
	  {"id":"e","type":"end"}]}`
	routeID := env.createRoute(t, "resilient", graph, true)
	token := "vc_sk_synthetic_nodefault"
	if err := env.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "nodefault", Name: "nodefault", KeyHash: hashProxyKey(token), Role: "developer", Status: "active",
		Scopes: []string{"chat:completion"}, DeniedProviders: []string{"test"},
	}); err != nil {
		t.Fatal(err)
	}
	resp, data := env.chat(t, "dynamic/resilient", "Authorization", "Bearer "+token)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(data), "ok from rescue-model") {
		t.Fatalf("route should reach the usable element: %d %s", resp.StatusCode, data)
	}
	if path := resp.Header.Get("X-Dynamic-Route-Path"); path != "s>gone:failed>denied:skipped>ok:success>e" {
		t.Fatalf("path = %q", path)
	}
	if len(env.primary.calls()) != 0 {
		t.Fatal("a provider denied to the key was called")
	}
	rows := env.routeRequests(t, routeID, 1)
	if rows[0].Fallbacks != 2 || rows[0].FinalElementID != "ok" {
		t.Fatalf("record: %+v", rows[0])
	}
	// With nothing usable left the client hears so, with the path.
	only := `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"gone"}}},
	  {"id":"gone","type":"model","properties":{"provider":"ghost","model":"ghost-model"},"outputs":{"success":{"elementId":"e"}}},
	  {"id":"e","type":"end"}]}`
	env.createRoute(t, "hopeless", only, true)
	resp, data = env.chat(t, "dynamic/hopeless", "Authorization", "Bearer "+token)
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Dynamic-Route-Path") != "s>gone:failed" {
		t.Fatalf("exhausted route: %d %q %s", resp.StatusCode, resp.Header.Get("X-Dynamic-Route-Path"), data)
	}
}
