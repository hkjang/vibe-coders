package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestGovernanceSecretPolicyBlocksBeforeUpstream(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"unexpected"}}]}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "block secrets",
		"rules": []any{
			map[string]any{"name": "secret firewall", "contains_secret": true, "block": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	resp = postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "please use api_key=sk-1234567890abcdefghijklmnopqrstuv"},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected governance block, got %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Secret-Firewall"); got != "block" {
		t.Fatalf("expected X-Secret-Firewall=block, got %q", got)
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("upstream should not be called on secret block")
	}
	events, err := db.ListSecretEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Action != "block" {
		t.Fatalf("expected blocked secret event, got %+v", events)
	}
	decisions, err := db.ListPolicyDecisionEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) == 0 || decisions[0].Decision != "block" || decisions[0].RuleName != "secret firewall" {
		t.Fatalf("expected blocked policy decision event, got %+v", decisions)
	}
	if decisions[0].RequestID == "" || decisions[0].Phase != "request" {
		t.Fatalf("expected request-linked policy decision, got %+v", decisions[0])
	}
	decisionResp, err := http.Get(proxy.URL + "/admin/policies/decisions?limit=10&decision=block&request_id=" + decisions[0].RequestID + "&window=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer decisionResp.Body.Close()
	if decisionResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(decisionResp.Body)
		t.Fatalf("policy decisions status %d: %s", decisionResp.StatusCode, body)
	}
	var decisionOut struct {
		PolicyDecisions []store.PolicyDecisionEvent `json:"policy_decisions"`
		Count           int                         `json:"count"`
		Filters         map[string]any              `json:"filters"`
	}
	if err := json.NewDecoder(decisionResp.Body).Decode(&decisionOut); err != nil {
		t.Fatal(err)
	}
	if decisionOut.Count != len(decisionOut.PolicyDecisions) || len(decisionOut.PolicyDecisions) == 0 || decisionOut.PolicyDecisions[0].Decision != "block" {
		t.Fatalf("expected policy decisions API to include block, got %+v", decisionOut)
	}
	if decisionOut.Filters["decision"] != "block" || decisionOut.Filters["request_id"] != decisions[0].RequestID {
		t.Fatalf("expected policy decisions API filters to echo request/decision, got %+v", decisionOut.Filters)
	}
	missResp, err := http.Get(proxy.URL + "/admin/policies/decisions?decision=mask&request_id=" + decisions[0].RequestID)
	if err != nil {
		t.Fatal(err)
	}
	defer missResp.Body.Close()
	var missOut struct {
		PolicyDecisions []store.PolicyDecisionEvent `json:"policy_decisions"`
		Count           int                         `json:"count"`
	}
	if err := json.NewDecoder(missResp.Body).Decode(&missOut); err != nil {
		t.Fatal(err)
	}
	if missOut.Count != 0 || len(missOut.PolicyDecisions) != 0 {
		t.Fatalf("expected filtered policy decisions miss, got %+v", missOut)
	}
	secretType := events[0].SecretType
	secretResp, err := http.Get(proxy.URL + "/admin/security/secrets?limit=10&action=block&request_id=" + url.QueryEscape(decisions[0].RequestID) + "&secret_type=" + url.QueryEscape(secretType) + "&window=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer secretResp.Body.Close()
	if secretResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(secretResp.Body)
		t.Fatalf("secret events status %d: %s", secretResp.StatusCode, body)
	}
	var secretOut struct {
		SecretEvents []store.SecretEvent `json:"secret_events"`
		Count        int                 `json:"count"`
		Filters      map[string]any      `json:"filters"`
	}
	if err := json.NewDecoder(secretResp.Body).Decode(&secretOut); err != nil {
		t.Fatal(err)
	}
	if secretOut.Count != len(secretOut.SecretEvents) || len(secretOut.SecretEvents) == 0 || secretOut.SecretEvents[0].Action != "block" {
		t.Fatalf("expected secret events API to include block, got %+v", secretOut)
	}
	if secretOut.Filters["action"] != "block" || secretOut.Filters["request_id"] != decisions[0].RequestID || secretOut.Filters["secret_type"] != secretType {
		t.Fatalf("expected secret events API filters to echo request/action/type, got %+v", secretOut.Filters)
	}
	secretMissResp, err := http.Get(proxy.URL + "/admin/security/secrets?action=mask&request_id=" + url.QueryEscape(decisions[0].RequestID))
	if err != nil {
		t.Fatal(err)
	}
	defer secretMissResp.Body.Close()
	var secretMissOut struct {
		SecretEvents []store.SecretEvent `json:"secret_events"`
		Count        int                 `json:"count"`
	}
	if err := json.NewDecoder(secretMissResp.Body).Decode(&secretMissOut); err != nil {
		t.Fatal(err)
	}
	if secretMissOut.Count != 0 || len(secretMissOut.SecretEvents) != 0 {
		t.Fatalf("expected filtered secret events miss, got %+v", secretMissOut)
	}
}

func TestGovernanceApprovalWorkflowAllowsApprovedRequest(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "approval for gpt-4.1",
		"rules": []any{
			map[string]any{"name": "model approval", "model": "gpt-4.1", "require_approval": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	body := map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	resp = postJSON(t, proxy.URL+"/v1/chat/completions", "", body)
	if resp.StatusCode != http.StatusLocked {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected approval required, got %d: %s", resp.StatusCode, raw)
	}
	approvalID := resp.Header.Get("X-Governance-Approval-ID")
	resp.Body.Close()
	if approvalID == "" {
		t.Fatal("expected approval id header")
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("upstream should not be called before approval")
	}

	resp = postJSON(t, proxy.URL+"/admin/approvals/"+approvalID+"/approve", "", map[string]any{})
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("approval status %d: %s", resp.StatusCode, raw)
	}
	resp.Body.Close()

	listResp, err := http.Get(proxy.URL + "/admin/approvals?status=approved&id=" + url.QueryEscape(approvalID) + "&subject_type=openai_request&window=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(listResp.Body)
		t.Fatalf("approval list status %d: %s", listResp.StatusCode, raw)
	}
	var approvalOut struct {
		Approvals []store.Approval `json:"approvals"`
		Count     int              `json:"count"`
		Filters   map[string]any   `json:"filters"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&approvalOut); err != nil {
		t.Fatal(err)
	}
	if approvalOut.Count != len(approvalOut.Approvals) || len(approvalOut.Approvals) != 1 || approvalOut.Approvals[0].ID != approvalID {
		t.Fatalf("expected filtered approval list to include approved approval, got %+v", approvalOut)
	}
	if approvalOut.Filters["status"] != "approved" || approvalOut.Filters["id"] != approvalID || approvalOut.Filters["subject_type"] != "openai_request" {
		t.Fatalf("expected approval filters to echo status/id/subject_type, got %+v", approvalOut.Filters)
	}
	missResp, err := http.Get(proxy.URL + "/admin/approvals?id=" + url.QueryEscape(approvalID) + "&user_id=missing-user")
	if err != nil {
		t.Fatal(err)
	}
	defer missResp.Body.Close()
	var approvalMiss struct {
		Approvals []store.Approval `json:"approvals"`
		Count     int              `json:"count"`
	}
	if err := json.NewDecoder(missResp.Body).Decode(&approvalMiss); err != nil {
		t.Fatal(err)
	}
	if approvalMiss.Count != 0 || len(approvalMiss.Approvals) != 0 {
		t.Fatalf("expected filtered approval miss, got %+v", approvalMiss)
	}

	encoded, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Governance-Approval-ID", approvalID)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected approved request to pass, got %d: %s", resp.StatusCode, raw)
	}
	if upstreamCalls.Load() != 1 {
		t.Fatalf("expected one upstream call after approval, got %d", upstreamCalls.Load())
	}
}

func TestGovernanceApprovalExpiryIsReflectedAndFinal(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	expired := store.Approval{
		ID:          "appr_expired_test",
		Status:      "pending",
		SubjectType: "openai_request",
		Reason:      "expired approval",
		ExpiresAt:   time.Now().UTC().Add(-time.Minute),
		CreatedAt:   time.Now().UTC().Add(-2 * time.Minute),
	}
	if err := db.InsertApproval(context.Background(), expired); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/admin/approvals?status=expired")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("approvals status %d: %s", resp.StatusCode, body)
	}
	var listed struct {
		Approvals []store.Approval `json:"approvals"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Approvals) != 1 || listed.Approvals[0].Status != "expired" {
		t.Fatalf("expected expired approval in list, got %+v", listed.Approvals)
	}

	approve := postJSON(t, proxy.URL+"/admin/approvals/"+expired.ID+"/approve", "", map[string]any{})
	defer approve.Body.Close()
	if approve.StatusCode != http.StatusConflict {
		body, _ := io.ReadAll(approve.Body)
		t.Fatalf("expected expired approval conflict, got %d: %s", approve.StatusCode, body)
	}
	got, found, err := db.GetApproval(context.Background(), expired.ID)
	if err != nil || !found {
		t.Fatalf("approval lookup found=%v err=%v", found, err)
	}
	if got.Status != "expired" {
		t.Fatalf("expired approval should remain expired, got %+v", got)
	}
}

func TestGovernanceApprovalIDIsBoundToAPIKey(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"unexpected"}}]}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	ctx := context.Background()
	apiKeyA := "vc_sk_approval_binding_a_1234567890abcdef"
	apiKeyB := "vc_sk_approval_binding_b_1234567890abcdef"
	for id, raw := range map[string]string{"key_a": apiKeyA, "key_b": apiKeyB} {
		if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
			ID:      id,
			Name:    id,
			KeyHash: hashProxyKey(raw),
			Status:  "active",
			Scopes:  []string{"chat:completion"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.InsertApproval(ctx, store.Approval{
		ID:          "appr_key_a_only",
		APIKeyID:    "key_a",
		SubjectType: "openai_request",
		Status:      "approved",
		Reason:      "pre-approved for key A only",
		ExpiresAt:   time.Now().UTC().Add(time.Hour),
		CreatedAt:   time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "approval for all gpt-4.1",
		"rules": []any{
			map[string]any{"name": "model approval", "model": "gpt-4.1", "require_approval": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	body := map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	encoded, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKeyB)
	req.Header.Set("X-Governance-Approval-ID", "appr_key_a_only")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusLocked {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected approval mismatch lock, got %d: %s", resp.StatusCode, raw)
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("upstream should not be called when approval belongs to another API key")
	}
}

func TestGovernancePolicyMatchesTeamName(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"unexpected"}}]}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	ctx := context.Background()
	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: "team_security", Name: "security"}); err != nil {
		t.Fatal(err)
	}
	apiKey := "vc_sk_team_name_policy_test_1234567890"
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID:      "key_team_name",
		Name:    "team-name-policy",
		KeyHash: hashProxyKey(apiKey),
		Team:    "team_security",
		Status:  "active",
		Scopes:  []string{"chat:completion"},
	}); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "block security team",
		"rules": []any{
			map[string]any{"name": "security team block", "team": "security", "block": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	resp = postJSON(t, proxy.URL+"/v1/chat/completions", apiKey, map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected team-name governance block, got %d: %s", resp.StatusCode, body)
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("upstream should not be called on team policy block")
	}
	decisions, err := db.ListPolicyDecisionEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) == 0 || decisions[0].TeamID != "team_security" || decisions[0].Decision != "block" {
		t.Fatalf("expected team-linked policy decision, got %+v", decisions)
	}
}

func TestGovernancePolicyPrecedenceBlockBeatsApprovalAndAuditsAllow(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "conflicting rules",
		"rules": []any{
			map[string]any{"name": "allow gpt", "model": "gpt-4.1", "allow_models": []string{"gpt-4.1"}, "allow": true},
			map[string]any{"name": "approval gpt", "model": "gpt-4.1", "require_approval": true},
			map[string]any{"name": "block gpt", "model": "gpt-4.1", "block": true},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create status %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	resp = postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("BLOCK must win over APPROVAL, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Governance-Approval-ID") != "" {
		t.Fatalf("blocked request must not allocate approval id, got %q", resp.Header.Get("X-Governance-Approval-ID"))
	}
	if upstreamCalls.Load() != 0 {
		t.Fatal("upstream should not be called on block precedence")
	}

	events, err := db.ListPolicyDecisionEvents(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range events {
		seen[e.Decision] = true
	}
	for _, want := range []string{"allow_model", "allow", "require_approval", "block"} {
		if !seen[want] {
			t.Fatalf("expected %s policy event, got %+v", want, events)
		}
	}
}

func TestGovernanceConditionHelpersCoverNumericAndSecretLists(t *testing.T) {
	g := governanceContext{
		TeamID:          "team_security",
		TeamName:        "security",
		Role:            "developer",
		Model:           "gpt-5",
		Provider:        "openai",
		Endpoint:        "/v1/chat/completions",
		RiskScore:       82,
		ComplexityScore: 64,
		CostKRW:         123.45,
		ContainsSecret:  true,
		SecretTypes:     []string{"password", "aws_secret"},
	}
	if !governanceRuleMatches(map[string]any{
		"team":             []any{"platform", "security"},
		"role":             "developer",
		"model":            "gpt-*",
		"provider":         "openai",
		"endpoint":         "/v1/*",
		"risk_score":       ">80",
		"complexity_score": json.Number("64"),
		"cost_krw":         "<=200",
		"contains_secret":  "true",
		"secret_type":      []any{"jwt", "aws_*"},
	}, g) {
		t.Fatal("expected mixed governance conditions to match")
	}
	for name, conditions := range map[string]map[string]any{
		"unknown condition": {"unknown": "value"},
		"bad number":        {"risk_score": ">>80"},
		"missing secret":    {"secret_type": []any{"jwt", "private_key"}},
		"wrong boolean":     {"contains_secret": false},
	} {
		if governanceRuleMatches(conditions, g) {
			t.Fatalf("%s should not match", name)
		}
	}
	for _, expr := range []string{">=82", "==82", "!=80", "<83", "82"} {
		if !numberCondition(82, expr) {
			t.Fatalf("number expression %q should match", expr)
		}
	}
	if numberCondition(82, "<=80") || numberCondition(82, "not-a-number") {
		t.Fatal("invalid numeric expressions should not match")
	}
	if secretActionDecision("weird") != "detect" || secretActionDecision("mask") != "mask" || secretActionDecision("block") != "block" {
		t.Fatal("unexpected secret action decision normalization")
	}
	masked := maskSecretText(`password=supersecret123 api_key=abcd1234abcd1234abcd sk-abcdefghijklmnopqrstuv`)
	for _, raw := range []string{"supersecret123", "abcd1234abcd1234abcd", "sk-abcdefghijklmnopqrstuv"} {
		if strings.Contains(masked, raw) {
			t.Fatalf("masked text leaked %q: %s", raw, masked)
		}
	}
}

func TestGovernanceSecretMaskPolicyRedactsBeforeUpstream(t *testing.T) {
	var upstreamBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		upstreamBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "mask request secrets",
		"rules": []any{
			map[string]any{"name": "mask passwords", "contains_secret": true, "secret_action": "mask"},
		},
	})
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("policy create status %d", resp.StatusCode)
	}

	resp = postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "gpt-4.1-mini",
		"messages": []any{
			map[string]any{"role": "user", "content": "deploy with password=supersecret123 and api_key=abcd1234abcd1234abcd"},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected masked request to pass, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Secret-Firewall") != "mask" {
		t.Fatalf("expected secret firewall mask header, got %q", resp.Header.Get("X-Secret-Firewall"))
	}
	for _, raw := range []string{"supersecret123", "abcd1234abcd1234abcd"} {
		if strings.Contains(upstreamBody, raw) {
			t.Fatalf("upstream body leaked %q: %s", raw, upstreamBody)
		}
	}
	if !strings.Contains(upstreamBody, "[REDACTED]") {
		t.Fatalf("expected upstream body to contain redaction marker, got %s", upstreamBody)
	}
	events, err := db.ListSecretEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Action != "mask" {
		t.Fatalf("expected masked secret event, got %+v", events)
	}
	decisions, err := db.ListPolicyDecisionEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) == 0 || decisions[0].Decision != "mask" || decisions[0].RuleName != "mask passwords" {
		t.Fatalf("expected mask policy decision, got %+v", decisions)
	}
}

func TestMCPToolRiskProfileBlocksCall(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertToolRiskProfile(ctx, store.ToolRiskProfile{
		ServerLabel: "fake",
		ToolName:    "echo",
		RiskLevel:   "critical",
		Action:      "block",
	}); err != nil {
		t.Fatal(err)
	}

	call := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fake__echo","arguments":{"text":"hi"}}}`)
	if call.Error == nil {
		t.Fatalf("expected governance risk block, got result: %s", call.Result)
	}
	if !strings.Contains(call.Error.Message, "governance") {
		t.Fatalf("expected governance error, got %+v", call.Error)
	}
}

func TestPromptReplayExecutesModelsAndStoresResults(t *testing.T) {
	var seenModels []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var root map[string]any
		_ = json.NewDecoder(r.Body).Decode(&root)
		seenModels = append(seenModels, root["model"].(string))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"replayed ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/replay", "", map[string]any{
		"prompt": "compare this",
		"models": []string{"model-a", "model-b"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("replay status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Job     store.ReplayJob       `json:"job"`
		Results []governanceRunResult `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Job.Status != "completed" || len(out.Results) != 2 {
		t.Fatalf("expected completed replay with 2 results, got %#v", out)
	}
	if len(seenModels) != 2 || seenModels[0] != "model-a" || seenModels[1] != "model-b" {
		t.Fatalf("upstream models = %v", seenModels)
	}
	jobs, err := db.ListReplayJobs(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) == 0 || jobs[0].Status != "completed" || !strings.Contains(jobs[0].Results, "replayed ok") {
		t.Fatalf("expected stored replay results, got %+v", jobs)
	}
}

func TestGoldenPromptRunStoresScore(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"The answer includes stable expected output."},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/golden-prompts", "", map[string]any{
		"name":     "Regression Case",
		"prompt":   "Return the expected output",
		"expected": "expected output",
		"models":   []string{"model-a"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("golden status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Results []store.GoldenPromptResult `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Results) != 1 || !out.Results[0].Passed || out.Results[0].Score < 1 {
		t.Fatalf("expected passing golden result, got %#v", out.Results)
	}
	results, err := db.ListGoldenPromptResults(context.Background(), "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].Passed {
		t.Fatalf("expected stored passing result, got %+v", results)
	}
}
