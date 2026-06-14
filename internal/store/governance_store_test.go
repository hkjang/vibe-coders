package store

import (
	"context"
	"testing"
	"time"
)

func TestGovernancePolicyApprovalSecretAndArtifactStores(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.UpsertPolicyWithRules(ctx, Policy{
		ID: "pol_security", Name: "security", Description: "security policy", Enabled: true, Priority: 10, CreatedAt: now.Add(-time.Hour),
	}, []PolicyRule{
		{ID: "rule_block", Name: "block secrets", Enabled: true, Priority: 1, Conditions: map[string]any{"contains_secret": true}, Actions: map[string]any{"block": true}},
		{ID: "rule_disabled", Name: "disabled", Enabled: false, Priority: 2, Actions: map[string]any{"allow": true}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertPolicyWithRules(ctx, Policy{ID: "pol_disabled", Name: "disabled policy", Enabled: false, Priority: 1}, []PolicyRule{
		{ID: "rule_in_disabled_policy", Name: "ignored", Enabled: true, Actions: map[string]any{"allow": true}},
	}); err != nil {
		t.Fatal(err)
	}
	policies, err := db.ListPolicies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[1].ID != "pol_security" || len(policies[1].Rules) != 2 {
		t.Fatalf("policy listing with rules mismatch: %+v", policies)
	}
	activeRules, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeRules) != 1 || activeRules[0].ID != "rule_block" || activeRules[0].Conditions["contains_secret"] != true {
		t.Fatalf("active policy rules mismatch: %+v", activeRules)
	}

	decision := PolicyDecisionEvent{
		ID: "pde_1", RequestID: "req_gov", APIKeyID: "key_gov", UserID: "usr_gov", TeamID: "team_gov",
		Endpoint: "/v1/chat/completions", Phase: "request", PolicyID: "pol_security", RuleID: "rule_block",
		RuleName: "block secrets", Decision: "block", Reason: "secret", Model: "gpt-4.1", Provider: "openai",
		RiskScore: 90, ComplexityScore: 70, CostKRW: 12.5, CreatedAt: now,
	}
	if err := db.InsertPolicyDecisionEvent(ctx, decision); err != nil {
		t.Fatal(err)
	}
	filteredDecisions, err := db.ListPolicyDecisionEventsFiltered(ctx, PolicyDecisionFilter{
		RequestID: "req_gov", APIKeyID: "key_gov", TeamID: "team_gov", Decision: "BLOCK", Model: "gpt-4.1", Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filteredDecisions) != 1 || filteredDecisions[0].Decision != "block" || filteredDecisions[0].RiskScore != 90 {
		t.Fatalf("policy decision filter mismatch: %+v", filteredDecisions)
	}
	byRequest, err := db.PolicyDecisionEventsForRequest(ctx, "req_gov")
	if err != nil {
		t.Fatal(err)
	}
	if len(byRequest) != 1 || byRequest[0].RuleID != "rule_block" {
		t.Fatalf("policy decisions for request mismatch: %+v", byRequest)
	}
	allDecisions, err := db.ListPolicyDecisionEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(allDecisions) != 1 {
		t.Fatalf("policy decision wrapper mismatch: %+v", allDecisions)
	}

	if err := db.InsertApproval(ctx, Approval{
		ID: "appr_expire", RequestID: "req_gov", APIKeyID: "key_gov", TeamID: "team_gov",
		SubjectType: "openai_request", SubjectID: "subj", Status: "pending", Reason: "risk", ExpiresAt: now.Add(-time.Minute), CreatedAt: now.Add(-2 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertApproval(ctx, Approval{
		ID: "appr_pending", RequestID: "req_gov", APIKeyID: "key_gov", TeamID: "team_gov",
		SubjectType: "openai_request", SubjectID: "subj2", Status: "pending", Reason: "needs review", ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	expired, err := db.ExpireApprovals(ctx, now)
	if err != nil || expired != 1 {
		t.Fatalf("expire approvals expired=%d err=%v", expired, err)
	}
	ok, err := db.SetPendingApprovalStatus(ctx, "appr_pending", "approved", "admin")
	if err != nil || !ok {
		t.Fatalf("pending approval transition ok=%v err=%v", ok, err)
	}
	ok, err = db.SetPendingApprovalStatus(ctx, "appr_pending", "rejected", "admin")
	if err != nil || ok {
		t.Fatalf("second pending transition must not update, ok=%v err=%v", ok, err)
	}
	if err := db.SetApprovalStatus(ctx, "appr_pending", "rejected", "admin2"); err != nil {
		t.Fatal(err)
	}
	approval, found, err := db.GetApproval(ctx, "appr_pending")
	if err != nil || !found || approval.Status != "rejected" || approval.DecidedBy != "admin2" {
		t.Fatalf("approval lookup mismatch found=%v err=%v approval=%+v", found, err, approval)
	}
	approvals, err := db.ListApprovalsFiltered(ctx, ApprovalFilter{RequestID: "req_gov", Reason: "risk", Status: "expired", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(approvals) != 1 || approvals[0].ID != "appr_expire" {
		t.Fatalf("approval filter mismatch: %+v", approvals)
	}
	if approvals, err := db.ApprovalsForRequest(ctx, "req_gov"); err != nil || len(approvals) != 2 {
		t.Fatalf("approvals for request err=%v approvals=%+v", err, approvals)
	}
	if approvals, err := db.ListApprovals(ctx, "rejected", 10); err != nil || len(approvals) != 1 {
		t.Fatalf("approval wrapper err=%v approvals=%+v", err, approvals)
	}

	secret := SecretEvent{
		ID: "sec_1", RequestID: "req_gov", APIKeyID: "key_gov", UserID: "usr_gov", TeamID: "team_gov",
		SecretType: "api_key", Action: "block", Location: "request_body.line1", MatchedHash: "hash", CreatedAt: now,
	}
	if err := db.InsertSecretEvent(ctx, secret); err != nil {
		t.Fatal(err)
	}
	secrets, err := db.ListSecretEventsFiltered(ctx, SecretEventFilter{RequestID: "req_gov", SecretType: "API_KEY", Action: "BLOCK", Location: "line1", MatchedHash: "hash", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(secrets) != 1 || secrets[0].ID != "sec_1" {
		t.Fatalf("secret filter mismatch: %+v", secrets)
	}
	if secrets, err := db.SecretEventsForRequest(ctx, "req_gov"); err != nil || len(secrets) != 1 {
		t.Fatalf("secrets for request err=%v secrets=%+v", err, secrets)
	}
	if secrets, err := db.ListSecretEvents(ctx, 10); err != nil || len(secrets) != 1 {
		t.Fatalf("secret wrapper err=%v secrets=%+v", err, secrets)
	}

	if err := db.UpsertToolRiskProfile(ctx, ToolRiskProfile{ServerLabel: "shell", ToolName: "*", RiskLevel: "critical", Action: "block", Note: "danger"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertToolRiskProfile(ctx, ToolRiskProfile{ServerLabel: "*", ToolName: "read", RiskLevel: "low", Action: "allow"}); err != nil {
		t.Fatal(err)
	}
	profile, found, err := db.ToolRiskProfile(ctx, "shell", "execute")
	if err != nil || !found || profile.Action != "block" {
		t.Fatalf("tool risk wildcard lookup mismatch found=%v err=%v profile=%+v", found, err, profile)
	}
	profiles, err := db.ListToolRiskProfiles(ctx)
	if err != nil || len(profiles) != 2 {
		t.Fatalf("tool risk profile list err=%v profiles=%+v", err, profiles)
	}

	if err := db.InsertReplayJob(ctx, ReplayJob{ID: "replay_1", SourceRequestID: "req_gov", Prompt: "hello", Models: []string{"gpt", "qwen"}, CreatedBy: "admin", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateReplayJob(ctx, "replay_1", "completed", `[{"ok":true}]`); err != nil {
		t.Fatal(err)
	}
	jobs, err := db.ListReplayJobs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Status != "completed" || len(jobs[0].Models) != 2 {
		t.Fatalf("replay job mismatch: %+v", jobs)
	}

	if err := db.UpsertGoldenPrompt(ctx, GoldenPrompt{ID: "gp_1", Name: "Golden", Prompt: "return ok", Expected: "ok", Tags: []string{"smoke"}, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertGoldenPromptResult(ctx, GoldenPromptResult{ID: "gpr_1", PromptID: "gp_1", Model: "gpt", Score: 0.9, Passed: true, CostKRW: 1.2, LatencyMS: 33, Response: "ok", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	goldens, err := db.ListGoldenPrompts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(goldens) != 1 || goldens[0].Tags[0] != "smoke" {
		t.Fatalf("golden prompt list mismatch: %+v", goldens)
	}
	results, err := db.ListGoldenPromptResults(ctx, "gp_1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].Passed || results[0].Response != "ok" {
		t.Fatalf("golden result list mismatch: %+v", results)
	}
}

func TestGovernanceAnomalyKnowledgeAndContextStores(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_anom", Name: "team key", Team: "team_alpha", KeyHash: "hash", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
		ID: "req_anom", TraceID: "req_anom", APIKeyID: "key_anom", Model: "gpt-4.1", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now,
	}}); err != nil {
		t.Fatal(err)
	}
	for _, event := range []AnomalyEvent{
		{ID: "anom_global", Scope: "global", ScopeValue: "*", Metric: "krw", Value: 20, Baseline: 10, Severity: "medium", Channel: "slack", CreatedAt: now},
		{ID: "anom_key", Scope: "api_key", ScopeValue: "key_anom", Metric: "krw", Value: 30, Baseline: 10, Severity: "high", CreatedAt: now},
		{ID: "anom_team", Scope: "team", ScopeValue: "team_alpha", Metric: "requests", Value: 40, Baseline: 10, Severity: "medium", CreatedAt: now},
		{ID: "anom_model", Scope: "model", ScopeValue: "gpt-4.1", Metric: "latency", Value: 50, Baseline: 10, Severity: "low", CreatedAt: now},
		{ID: "anom_old", Scope: "api_key", ScopeValue: "key_anom", Metric: "krw", Value: 1, Baseline: 1, Severity: "low", CreatedAt: now.Add(-48 * time.Hour)},
	} {
		if err := db.InsertAnomalyEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	exists, err := db.RecentAnomalyEventExists(ctx, "api_key", "key_anom", "krw", now.Add(-time.Hour))
	if err != nil || !exists {
		t.Fatalf("recent anomaly should exist, exists=%v err=%v", exists, err)
	}
	exists, err = db.RecentAnomalyEventExists(ctx, "api_key", "missing", "krw", now.Add(-time.Hour))
	if err != nil || exists {
		t.Fatalf("missing anomaly exists=%v err=%v", exists, err)
	}
	requestEvents, err := db.AnomalyEventsForRequest(ctx, "req_anom", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(requestEvents) != 4 {
		t.Fatalf("anomaly events for request should match global/key/team/model, got %+v", requestEvents)
	}
	allAnomalies, err := db.ListAnomalyEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(allAnomalies) != 5 || allAnomalies[0].Status != "open" {
		t.Fatalf("anomaly list/status mismatch: %+v", allAnomalies)
	}

	if err := db.UpsertKnowledge(ctx, KnowledgeSnippet{ID: "ctx_api", Name: "API", Content: "rules", Enabled: true, TokenEstimate: 10}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertKnowledge(ctx, KnowledgeSnippet{ID: "ctx_disabled", Name: "Disabled", Content: "off", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := db.TouchKnowledge(ctx, []string{"ctx_api", ""}); err != nil {
		t.Fatal(err)
	}
	knowledge, err := db.ListKnowledge(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(knowledge) != 2 || knowledge[0].Name != "API" || knowledge[0].UseCount != 1 || knowledge[0].LastUsedAt == "" {
		t.Fatalf("knowledge list/touch mismatch: %+v", knowledge)
	}
	activeKnowledge, err := db.ActiveKnowledge(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeKnowledge) != 1 || activeKnowledge[0].ID != "ctx_api" {
		t.Fatalf("active knowledge mismatch: %+v", activeKnowledge)
	}
	if err := db.DeleteKnowledge(ctx, "ctx_disabled"); err != nil {
		t.Fatal(err)
	}
	knowledge, _ = db.ListKnowledge(ctx)
	if len(knowledge) != 1 {
		t.Fatalf("delete knowledge mismatch: %+v", knowledge)
	}

	if err := db.UpsertContextRegistry(ctx, ContextRegistryEntry{ID: "ctx_1", Key: "ctx_api", Name: "API", Content: "rules", Enabled: true, TokenEstimate: 10}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertContextRegistry(ctx, ContextRegistryEntry{ID: "ctx_2", Key: "ctx_off", Name: "Off", Content: "off", Enabled: false, TokenEstimate: 5}); err != nil {
		t.Fatal(err)
	}
	if err := db.TouchContextRegistry(ctx, []string{"ctx_api", "", "missing"}); err != nil {
		t.Fatal(err)
	}
	contexts, err := db.ListContextRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(contexts) != 2 || contexts[0].Key != "ctx_api" || contexts[0].UseCount != 1 || contexts[0].LastUsedAt.IsZero() {
		t.Fatalf("context registry list/touch mismatch: %+v", contexts)
	}
	activeContexts, err := db.ActiveContextRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeContexts) != 1 || activeContexts[0].Key != "ctx_api" {
		t.Fatalf("active context registry mismatch: %+v", activeContexts)
	}
}
