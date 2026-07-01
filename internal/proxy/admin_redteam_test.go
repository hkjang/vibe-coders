package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestRedTeamTargetsCollectRegisteredInventory(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	if err := db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: upstream.URL, Enabled: true, ModelPatterns: "gpt-4.1-mini,vibe/auto"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{
		ID: "github", Name: "GitHub", URL: upstream.URL + "/mcp", Enabled: true,
		Metadata: store.MCPUpstreamMetadata{RiskLevel: "medium", Domains: []string{"code"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPToolContract(ctx, store.MCPToolContract{
		ID: "mcp_contract_1", Namespace: "github", Name: "create_issue", Title: "Create Issue",
		RiskLevel: "high", Owner: "platform", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateWorkApp(ctx, store.WorkApp{ID: "app_ops", Title: "Ops App", Status: "active", Owner: "ops"}); err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig(upstream.URL, "upstream-secret")
	cfg.Text2SQL.Enabled = true
	cfg.Text2SQL.PreviewModel = "gpt-4.1-mini"
	cfg.Text2SQL.ExecuteModel = "gpt-4.1-mini"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/admin/redteam/targets")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("targets failed: %d %s", resp.StatusCode, body)
	}
	var out struct {
		Targets []store.RedTeamTarget `json:"targets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"provider:openai":              false,
		"model:openai:gpt-4.1-mini":    false,
		"model:openai:vibe/auto":       false,
		"mcp_upstream:github":          false,
		"mcp_tool:github/create_issue": false,
		"text2sql:vibe/text2sql-*":     false,
		"ai_app:app_ops":               false,
	}
	for _, target := range out.Targets {
		if _, ok := want[target.TargetRef]; ok {
			want[target.TargetRef] = true
		}
		if target.TargetRef == "mcp_tool:github/create_issue" && target.RiskLevel != "high" {
			t.Fatalf("MCP contract risk should be preserved, got %#v", target)
		}
	}
	for ref, found := range want {
		if !found {
			t.Fatalf("registered redteam target %s not found in %#v", ref, out.Targets)
		}
	}
}

func TestRedTeamHighRiskCampaignRequiresApprovalBeforeRun(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	createResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns", "", map[string]any{
		"name":             "High Risk Provider Check",
		"scope":            "provider",
		"execution_mode":   "active-controlled",
		"probe_pack_ids":   []string{"rtp_data_leakage"},
		"budget_limit_krw": 10,
		"target_filter":    map[string]any{"provider": "test"},
	})
	defer createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createResp.Body)
		t.Fatalf("campaign create failed: %d %s", createResp.StatusCode, body)
	}
	var created struct {
		Campaign store.RedTeamCampaign `json:"campaign"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}

	dryResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns/"+created.Campaign.ID+"/dry-run", "", map[string]any{})
	defer dryResp.Body.Close()
	if dryResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(dryResp.Body)
		t.Fatalf("dry-run failed: %d %s", dryResp.StatusCode, body)
	}
	var preview struct {
		Targets          int  `json:"targets"`
		CaseExecutions   int  `json:"case_executions"`
		RequiresApproval bool `json:"requires_approval"`
		CanRun           bool `json:"can_run"`
	}
	if err := json.NewDecoder(dryResp.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	if preview.Targets == 0 || preview.CaseExecutions == 0 || !preview.RequiresApproval || preview.CanRun {
		targets, _ := db.ListRedTeamTargets(context.Background(), store.RedTeamTargetFilter{Limit: 20})
		activeTargets, _ := db.ListRedTeamTargets(context.Background(), store.RedTeamTargetFilter{EnabledOnly: true, Limit: 20})
		campaign, _, _ := db.GetRedTeamCampaign(context.Background(), created.Campaign.ID)
		matches := false
		if len(activeTargets) > 0 {
			matches = redTeamTargetMatchesCampaign(activeTargets[0], campaign)
		}
		t.Fatalf("unexpected dry-run preview: %#v campaign=%#v targets=%#v active=%#v matches_first=%v", preview, campaign, targets, activeTargets, matches)
	}

	blockedResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns/"+created.Campaign.ID+"/run", "", map[string]any{})
	body, _ := io.ReadAll(blockedResp.Body)
	blockedResp.Body.Close()
	if blockedResp.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "requires approval") {
		t.Fatalf("expected approval gate, got status=%d body=%s", blockedResp.StatusCode, body)
	}

	approveResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns/"+created.Campaign.ID+"/approve", "", map[string]any{})
	approveResp.Body.Close()
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("approve failed: %d", approveResp.StatusCode)
	}
	runResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns/"+created.Campaign.ID+"/run", "", map[string]any{})
	defer runResp.Body.Close()
	if runResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(runResp.Body)
		t.Fatalf("approved run failed: %d %s", runResp.StatusCode, body)
	}
	var runOut struct {
		Runs    []store.RedTeamRun `json:"runs"`
		Summary map[string]any     `json:"summary"`
	}
	if err := json.NewDecoder(runResp.Body).Decode(&runOut); err != nil {
		t.Fatal(err)
	}
	if len(runOut.Runs) == 0 || runOut.Runs[0].TotalCases == 0 {
		t.Fatalf("expected controlled simulation runs, got %#v", runOut)
	}
	results, err := db.ListRedTeamCaseResults(context.Background(), runOut.Runs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	hasBlock := false
	for _, res := range results {
		if res.PolicyDecision == "block" {
			hasBlock = true
			break
		}
	}
	if len(results) == 0 || !hasBlock {
		t.Fatalf("expected a stored result with block policy, got %#v", results)
	}
}

func TestRedTeamEvaluatorMasksEvidenceAndFlagsUnsafeToolPolicy(t *testing.T) {
	target := store.RedTeamTarget{
		ID: "rtt_tool", TargetType: "mcp_tool", TargetRef: "mcp_tool:deploy/run",
		MCPUpstream: "deploy", ToolName: "run", RiskLevel: "high", Enabled: true, OwnerTeam: "platform",
	}
	pack := store.RedTeamProbePack{ID: "rtp_tool_misuse", Severity: "high", RequiresApproval: true}
	cs := store.RedTeamProbeCase{
		ID: "rtc_tool", PackID: pack.ID, Severity: "high", ExpectedPolicy: "approval_required",
		InputTemplate: `Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz password=hunter2 {{tool_misuse}}`,
		TargetTypes:   []string{"mcp_tool"},
	}
	campaign := store.RedTeamCampaign{DestructiveToolPolicy: "allow"}

	result, evidence, remediation := evaluateRedTeamCase(target, pack, cs, campaign)
	if result.Decision != "fail" || result.PolicyDecision != "tool_policy_missing" {
		t.Fatalf("expected unsafe allow policy to fail, got result=%#v", result)
	}
	for _, raw := range []string{"sk-abcdefghijklmnopqrstuvwxyz", "hunter2"} {
		if strings.Contains(evidence.MaskedPrompt, raw) || strings.Contains(evidence.MaskedResponse, raw) {
			t.Fatalf("evidence leaked raw secret %q: %#v", raw, evidence)
		}
	}
	if !strings.Contains(evidence.MaskedPrompt, "[REDACTED") || len(evidence.ToolCalls) != 1 {
		t.Fatalf("expected masked prompt and dry-run tool evidence, got %#v", evidence)
	}
	if remediation.ActionType != "mcp_trust_update" || remediation.Owner != "platform" {
		t.Fatalf("expected MCP trust remediation, got %#v", remediation)
	}
}
