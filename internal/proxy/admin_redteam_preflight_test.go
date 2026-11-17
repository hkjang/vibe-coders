package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func TestRedTeamPreflightApprovalIsNotExecutionReadiness(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "synthetic-unused"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	resp := postJSON(t, proxy.URL+"/admin/redteam/campaigns", "", map[string]any{
		"name": "사전 점검 계약", "scope": "provider", "execution_mode": "dry-run",
		"probe_pack_ids": []string{"rtp_data_leakage"}, "budget_limit_krw": 0.01,
	})
	var created struct {
		Campaign store.RedTeamCampaign `json:"campaign"`
	}
	if resp.StatusCode != 201 {
		t.Fatal("fixture campaign not created")
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	url := proxy.URL + "/admin/redteam/campaigns/" + created.Campaign.ID
	resp = postJSON(t, url+"/dry-run", "", map[string]any{})
	var preview map[string]any
	if resp.StatusCode != 200 {
		t.Fatal("preflight unavailable")
	}
	if err := json.NewDecoder(resp.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if preview["campaign_id"] != created.Campaign.ID || preview["can_run"] != true || preview["approved"] != false || preview["requires_approval"] != true {
		t.Fatal("dry-run approval exception changed")
	}
	if preview["estimated_cost_krw"].(float64) <= 0.01 || preview["case_executions"].(float64) <= 0 {
		t.Fatal("expected nonempty over-budget estimate")
	}
	for _, name := range redTeamPreflightOpenAPISchema()["required"].([]string) {
		if _, ok := preview[name]; !ok {
			t.Fatalf("missing documented preflight field %s", name)
		}
	}
	resp = postJSON(t, url+"/run", "", map[string]any{})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 || !strings.Contains(string(body), "budget limit exceeded") {
		t.Fatal("approval-only result was treated as execution permission")
	}
	if calls.Load() != 0 {
		t.Fatal("preflight or budget rejection contacted an upstream")
	}
}

func TestRedTeamPreflightOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	const path = "/admin/redteam/campaigns/{id}/dry-run"
	assertJSONOperationSchema(t, paths, path, "post", "200", "RedTeamPreflightResponse")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	response, ok := schemas["RedTeamPreflightResponse"].(map[string]any)
	if !ok || len(response["required"].([]any)) != 14 {
		t.Fatal("documented preflight response does not resolve to its complete schema")
	}
	description := paths[path].(map[string]any)["post"].(map[string]any)["description"].(string)
	for _, part := range []string{"without upstream model calls", "approval gating", "not overall execution readiness", "stored configuration"} {
		if !strings.Contains(description, part) {
			t.Fatalf("missing preflight boundary %s", part)
		}
	}
}
