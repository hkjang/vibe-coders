package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestWorkflowGraphAuthenticatedHTTPAndMCPReceipts(t *testing.T) {
	db, gateway := newAuthTestServer(t, "http://example.invalid")
	defer gateway.Close()
	var session struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(graphHTTP(t, gateway.URL, "POST", "/auth/login", "", []byte(`{"email":"root@example.com","password":"correct-password"}`), 200), &session); err != nil {
		t.Fatal(err)
	}
	var me struct {
		User struct {
			ID string `json:"id"`
		}
	}
	if err := json.Unmarshal(graphHTTP(t, gateway.URL, "GET", "/auth/me", session.AccessToken, nil, 200), &me); err != nil || me.User.ID == "" {
		t.Fatal("missing identity")
	}
	for _, user := range []string{me.User.ID, "other-owner"} {
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "graph-key-" + user, Name: "graph-entrypoint", KeyHash: hashProxyKey("fixture-key-" + user), UserID: user, Status: "active", Scopes: []string{"mcp:use"}}); err != nil {
			t.Fatal(err)
		}
	}
	wf := runtimeBranchFixture()
	wf.Name = "분기 실행"
	wf.Enabled = true
	if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal(err)
	}
	graphHTTP(t, gateway.URL, "POST", "/v1/workflows/branch/run", "", []byte(`{"execute":true}`), 401)
	for _, entry := range []string{"http", "mcp"} {
		for _, branch := range []string{"true", "false"} {
			t.Run(entry+"_"+branch, func(t *testing.T) {
				input := ""
				middle := "no"
				if branch == "true" {
					input = "private-workflow-input-canary"
					middle = "yes"
				}
				var result struct {
					RunID   string `json:"run_id"`
					Status  string `json:"status"`
					Results []struct {
						StepID string `json:"step_id"`
						Branch string `json:"branch"`
					} `json:"results"`
				}
				if entry == "http" {
					body, _ := json.Marshal(map[string]any{"execute": true, "input": input})
					if err := json.Unmarshal(graphHTTP(t, gateway.URL, "POST", "/v1/workflows/branch/run", session.AccessToken, body, 200), &result); err != nil {
						t.Fatal(err)
					}
				} else {
					body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "gateway_run_workflow", "arguments": map[string]string{"workflow_id": "branch", "input": input}}})
					raw := graphHTTP(t, gateway.URL, "POST", "/mcp/gateway", "fixture-key-"+me.User.ID, body, 200)
					var rpc struct {
						Result struct {
							Content []struct {
								Text string `json:"text"`
							} `json:"content"`
							IsError bool `json:"isError"`
						} `json:"result"`
					}
					if err := json.Unmarshal(raw, &rpc); err != nil || rpc.Result.IsError || len(rpc.Result.Content) != 1 {
						t.Fatalf("RPC response %s", raw)
					}
					if err := json.Unmarshal([]byte(rpc.Result.Content[0].Text), &result); err != nil {
						t.Fatal(err)
					}
				}
				if result.Status != "ok" || result.RunID == "" || len(result.Results) != 3 {
					t.Fatalf("execution %+v", result)
				}
				ids := []string{}
				for _, step := range result.Results {
					ids = append(ids, step.StepID)
				}
				if !reflect.DeepEqual(ids, []string{"start", middle, "merge"}) || result.Results[0].Branch != branch {
					t.Fatalf("wrong branch %+v", result)
				}
				receipt := graphHTTP(t, gateway.URL, "GET", "/v1/workflow-runs/"+result.RunID+"/receipt", session.AccessToken, nil, 200)
				if strings.Contains(string(receipt), "private-workflow-input-canary") {
					t.Fatal("receipt leaked input")
				}
				var saved struct {
					Steps []store.WorkflowStepRun `json:"steps"`
				}
				if err := json.Unmarshal(receipt, &saved); err != nil || len(saved.Steps) != 3 {
					t.Fatalf("receipt %s", receipt)
				}
				if saved.Steps[0].StepID != "start" || saved.Steps[0].DefinitionIndex == nil || *saved.Steps[0].DefinitionIndex != 2 || saved.Steps[0].Branch != branch {
					t.Fatal("receipt missing selected graph path")
				}
				graphHTTP(t, gateway.URL, "GET", "/v1/workflow-runs/"+result.RunID+"/receipt", "fixture-key-other-owner", nil, 403)
			})
		}
	}
	wf.AllowedTeams = "not-the-callers-team"
	if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal(err)
	}
	graphHTTP(t, gateway.URL, "POST", "/v1/workflows/branch/run", session.AccessToken, []byte(`{"execute":true}`), 403)
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_run_workflow","arguments":{"workflow_id":"branch","input":"hidden"}}}`)
	result := graphHTTP(t, gateway.URL, "POST", "/mcp/gateway", "fixture-key-"+me.User.ID, body, 200)
	if !strings.Contains(string(result), "workflow not allowed for your team") {
		t.Fatalf("MCP team restriction missing: %s", result)
	}
}
