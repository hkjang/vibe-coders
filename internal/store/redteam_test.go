package store

import (
	"context"
	"testing"
)

func TestRedTeamTargetSyncDisablesStaleTargets(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.SyncRedTeamTargets(ctx, []RedTeamTarget{
		{ID: "rtt_provider", TargetType: "provider", TargetRef: "provider:openai", Provider: "openai", RiskLevel: "medium", Enabled: true, Metadata: map[string]any{"external": true}},
		{ID: "rtt_tool", TargetType: "mcp_tool", TargetRef: "mcp_tool:git/write_file", MCPUpstream: "git", ToolName: "write_file", RiskLevel: "high", Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}

	active, err := db.ListRedTeamTargets(ctx, RedTeamTargetFilter{EnabledOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("expected two active targets, got %#v", active)
	}

	if err := db.SyncRedTeamTargets(ctx, []RedTeamTarget{
		{ID: "rtt_provider", TargetType: "provider", TargetRef: "provider:openai", Provider: "openai", RiskLevel: "low", Enabled: true, Metadata: map[string]any{"external": false}},
	}); err != nil {
		t.Fatal(err)
	}
	active, err = db.ListRedTeamTargets(ctx, RedTeamTargetFilter{EnabledOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 1 || active[0].ID != "rtt_provider" {
		t.Fatalf("expected stale MCP target to be disabled, got %#v", active)
	}
	all, err := db.ListRedTeamTargets(ctx, RedTeamTargetFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected disabled stale row to remain for audit history, got %#v", all)
	}
}

func TestRedTeamProbeCampaignEvidenceRoundTrip(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	pack := RedTeamProbePack{
		ID: "rtp_custom", Name: "Custom Pack", Category: "policy_bypass",
		Severity: "high", Version: "v1", Enabled: true, RequiresApproval: true, CreatedBy: "tester",
	}
	cases := []RedTeamProbeCase{{
		ID: "rtc_custom_1", PackID: pack.ID, CaseKey: "secret_leak",
		InputTemplate: "synthetic {{sensitive_data_request}}", ExpectedPolicy: "mask_or_block",
		EvaluatorType: "rule", Severity: "high", RiskTags: []string{"secret"}, TargetTypes: []string{"provider"},
		Parameters: map[string]any{"temperature": 0},
	}}
	if err := db.UpsertRedTeamProbePackWithCases(ctx, pack, cases); err != nil {
		t.Fatal(err)
	}
	packs, err := db.ListRedTeamProbePacks(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(packs) != 1 || len(packs[0].Cases) != 1 || packs[0].Cases[0].RiskTags[0] != "secret" {
		t.Fatalf("probe pack/case roundtrip failed: %#v", packs)
	}

	campaign := RedTeamCampaign{
		ID: "rtc_1", Name: "Release Red Team", Scope: "provider", Status: "draft",
		ExecutionMode: "active-controlled", ProbePackIDs: []string{pack.ID},
		TargetFilter: map[string]any{"provider": "openai"}, EvidenceRetentionDays: 30,
		DestructiveToolPolicy: "dry-run",
	}
	if err := db.UpsertRedTeamCampaign(ctx, campaign); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateRedTeamCampaignStatus(ctx, campaign.ID, "approved", "security-admin"); err != nil {
		t.Fatal(err)
	}
	gotCampaign, found, err := db.GetRedTeamCampaign(ctx, campaign.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !found || gotCampaign.Status != "approved" || gotCampaign.ApprovedBy != "security-admin" || gotCampaign.ProbePackIDs[0] != pack.ID {
		t.Fatalf("campaign roundtrip failed: found=%v campaign=%#v", found, gotCampaign)
	}

	run := RedTeamRun{ID: "rtrun_1", CampaignID: campaign.ID, TargetID: "rtt_provider", Status: "running", Mode: "active-controlled"}
	if err := db.InsertRedTeamRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	run.Status, run.TotalCases, run.FailedCases, run.RiskScore, run.CostKRW = "failed", 1, 1, 70, 0.2
	if err := db.UpdateRedTeamRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	result := RedTeamCaseResult{
		ID: "rtr_1", RunID: run.ID, CaseID: cases[0].ID, Decision: "fail", Severity: "high",
		EvidenceHash: "hash", PolicyDecision: "tool_policy_missing", LatencyMS: 1, CostKRW: 0.2,
	}
	if err := db.InsertRedTeamCaseResult(ctx, result); err != nil {
		t.Fatal(err)
	}
	evidence := RedTeamEvidence{
		ID: "rtev_1", ResultID: result.ID, MaskedPrompt: "[REDACTED]", MaskedResponse: "SAFE",
		ToolCalls:      []map[string]any{{"tool": "write_file", "dry_run": true}},
		HeadersSummary: map[string]any{"x-cost-center": "redteam"}, ExportHash: "hash",
	}
	if err := db.InsertRedTeamEvidence(ctx, evidence); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamRemediation(ctx, RedTeamRemediation{
		ID: "rtrm_1", ResultID: result.ID, ActionType: "policy_draft", Status: "open",
		ActionPayload: map[string]any{"recommendation": "tighten policy"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamBaseline(ctx, RedTeamBaseline{ID: "rtb_1", TargetID: "rtt_provider", PackID: pack.ID, BaselineScore: 5, DriftThreshold: 10}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamSchedule(ctx, RedTeamSchedule{ID: "rts_1", CampaignTemplateID: campaign.ID, CronExpr: "0 9 * * 1", Timezone: "Asia/Seoul", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	results, err := db.ListRedTeamCaseResults(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Decision != "fail" {
		t.Fatalf("result roundtrip failed: %#v", results)
	}
	gotEvidence, found, err := db.RedTeamEvidenceByResult(ctx, result.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !found || gotEvidence.MaskedPrompt != "[REDACTED]" || gotEvidence.HeadersSummary["x-cost-center"] != "redteam" || len(gotEvidence.ToolCalls) != 1 {
		t.Fatalf("evidence roundtrip failed: found=%v evidence=%#v", found, gotEvidence)
	}
	rems, err := db.ListRedTeamRemediations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rems) != 1 || rems[0].ActionPayload["recommendation"] != "tighten policy" {
		t.Fatalf("remediation roundtrip failed: %#v", rems)
	}
	baselines, err := db.ListRedTeamBaselines(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(baselines) != 1 || baselines[0].TargetID != "rtt_provider" {
		t.Fatalf("baseline roundtrip failed: %#v", baselines)
	}
	schedules, err := db.ListRedTeamSchedules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedules) != 1 || !schedules[0].Enabled {
		t.Fatalf("schedule roundtrip failed: %#v", schedules)
	}
}
