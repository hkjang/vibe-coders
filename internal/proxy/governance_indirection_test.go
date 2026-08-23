package proxy

import (
	"bytes"
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

// Reaching a denied model without naming it.
//
// The Text2SQL validator was bypassed three times running by ordinary SQL that reaches
// data without writing the name the check looks for. Governance matches models by name
// too, and the gateway offers a ready-made indirection: an agent route maps a virtual
// model to a real backing model, and the request only ever names the virtual one.
//
// It holds: the deny applies either way, and the upstream is never called. Instrumenting
// the policy loop shows why — by the time governance evaluates, the model it is handed is
// already "expensive-model" rather than "helper", so the name the rule looks for is the
// one that arrives.
//
// What is asserted below is that outcome, not the mechanism that produces it. Moving the
// governance step ahead of the agent-route step does not change the result, so the
// resolution happens somewhere earlier than the step order, and this test deliberately
// does not claim to know where. It fails if a denied model ever reaches the upstream,
// which is the property worth keeping however it is arranged.

func governanceFixture(t *testing.T) (proxyURL string, upstreamModel *string, db *store.SQLStore) {
	t.Helper()
	var seen string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var p struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &p)
		seen = p.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`))
	}))
	t.Cleanup(upstream.Close)

	db = openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	ctx := context.Background()
	if err := db.UpsertAgentRoute(ctx, store.AgentRoute{
		ID: "a1", VirtualModel: "helper", Name: "helper", Enabled: true,
		BackingModel: "expensive-model", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig(upstream.URL, "s")
	cfg.Auth.AdminToken = "rw"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts.URL, &seen, db
}

func setDenyModelPolicy(t *testing.T, db *store.SQLStore, enabled bool) {
	t.Helper()
	if err := db.UpsertPolicyWithRules(context.Background(),
		store.Policy{ID: "p1", Name: "no expensive model", Enabled: enabled, Priority: 10},
		[]store.PolicyRule{{
			ID: "r1", PolicyID: "p1", Name: "deny", Enabled: true, Priority: 10,
			Conditions: map[string]any{},
			Actions:    map[string]any{"deny_models": []any{"expensive-model"}},
		}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond) // the rule cache reloads
}

func callModel(t *testing.T, proxyURL, model string, seen *string) (int, string) {
	t.Helper()
	*seen = ""
	body, _ := json.Marshal(map[string]any{"model": model,
		"messages": []map[string]string{{"role": "user", "content": "hi"}}})
	req, err := http.NewRequest(http.MethodPost, proxyURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Mode", "passthrough")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, *seen
}

func TestAVirtualModelCannotReachADeniedBackingModel(t *testing.T) {
	proxyURL, seen, db := governanceFixture(t)

	// With the policy off, the route reaches the backing model. Without this the test
	// could pass on a route that never worked, which would prove nothing about the deny.
	setDenyModelPolicy(t, db, false)
	if code, up := callModel(t, proxyURL, "helper", seen); code != http.StatusOK || up != "expensive-model" {
		t.Fatalf("with the policy disabled the virtual route should reach expensive-model: "+
			"status=%d upstream saw %q", code, up)
	}

	setDenyModelPolicy(t, db, true)

	if code, up := callModel(t, proxyURL, "expensive-model", seen); code == http.StatusOK {
		t.Fatalf("the denied model was served when named directly (upstream saw %q)", up)
	}
	code, up := callModel(t, proxyURL, "helper", seen)
	if code == http.StatusOK {
		t.Errorf("a denied model was reached through a virtual route: the request named "+
			"\"helper\" and the upstream received %q. Governance matches models by name, so "+
			"any indirection that renames the model has to be resolved before the rule is "+
			"evaluated, or the rule matches nothing.", up)
	}
	if up != "" {
		t.Errorf("the upstream was called with %q despite the request being refused", up)
	}

	// And an unrelated model still goes through, so the policy is not simply blocking
	// everything.
	if code, _ := callModel(t, proxyURL, "cheap-model", seen); code != http.StatusOK {
		t.Errorf("an unrelated model was refused (status=%d); the deny is too broad", code)
	}
}
