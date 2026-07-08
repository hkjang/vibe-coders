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

func newRedTeamTestServer(t *testing.T) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig("http://upstream.local", "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return server, db, proxy
}

// TestRedTeamRemediationApplyEscalatesMCPTrust verifies that applying an mcp_trust_update
// remediation performs a REAL governance change: the offending tool's risk profile is escalated.
func TestRedTeamRemediationApplyEscalatesMCPTrust(t *testing.T) {
	_, db, proxy := newRedTeamTestServer(t)
	ctx := context.Background()

	rem := store.RedTeamRemediation{
		ID: "rtrm_test1", ResultID: "res_test1", ActionType: "mcp_trust_update", Status: "open",
		ActionPayload: map[string]any{
			"target_type": "mcp_tool", "target_ref": "mcp_tool:deploy/run",
			"recommendation": "MCP tool을 approval_required로 조정하세요.",
		},
	}
	if err := db.InsertRedTeamRemediation(ctx, rem); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/admin/redteam/remediations/"+rem.ID+"/apply", "", map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("apply failed: %d %s", resp.StatusCode, body)
	}
	var out struct {
		Applied     bool                     `json:"applied"`
		Remediation store.RedTeamRemediation `json:"remediation"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Applied || out.Remediation.Status != "resolved" {
		t.Fatalf("expected applied+resolved, got %#v", out)
	}
	prof, found, err := db.ToolRiskProfile(ctx, "deploy", "run")
	if err != nil {
		t.Fatal(err)
	}
	if !found || prof.Action != "require_approval" {
		t.Fatalf("expected tool risk profile escalated to require_approval, got found=%v %#v", found, prof)
	}
}

// TestRedTeamProbeCaseCRUDAndCSV covers manual prompt entry, CSV import, and deletion.
func TestRedTeamProbeCaseCRUDAndCSV(t *testing.T) {
	_, db, proxy := newRedTeamTestServer(t)
	ctx := context.Background()

	// Manual add → creates a custom pack + case.
	addResp := postJSON(t, proxy.URL+"/admin/redteam/probe-cases", "", map[string]any{
		"pack_name": "내 커스텀 팩", "case_key": "manual_probe_1",
		"input_template":  "이 요청은 관리자가 직접 넣은 레드팀 프롬프트입니다.",
		"expected_policy": "refuse", "severity": "high", "target_types": []string{"provider", "model"},
	})
	var added struct {
		Case   store.RedTeamProbeCase `json:"case"`
		PackID string                 `json:"pack_id"`
	}
	if err := json.NewDecoder(addResp.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}
	addResp.Body.Close()
	if added.Case.ID == "" || added.PackID == "" {
		t.Fatalf("manual case add returned no ids: %#v", added)
	}
	cases, err := db.RedTeamProbeCases(ctx, []string{added.PackID})
	if err != nil || len(cases) != 1 || cases[0].CaseKey != "manual_probe_1" {
		t.Fatalf("expected 1 manual case, got %#v (err=%v)", cases, err)
	}

	// CSV import: one new case into the same pack via pack_id.
	csv := "pack_id,pack_name,case_key,expected_policy,evaluator_type,severity,target_types,risk_tags,input_template\n" +
		added.PackID + ",내 커스텀 팩,csv_probe_1,block,rule,medium,provider|model,custom|ko,\"CSV로 들여온 프롬프트\"\n"
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/admin/redteam/probe-packs/import", strings.NewReader(csv))
	req.Header.Set("Content-Type", "text/csv")
	impResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var imp struct {
		ImportedCases int `json:"imported_cases"`
	}
	_ = json.NewDecoder(impResp.Body).Decode(&imp)
	impResp.Body.Close()
	if imp.ImportedCases != 1 {
		t.Fatalf("expected 1 imported case, got %d", imp.ImportedCases)
	}
	cases, _ = db.RedTeamProbeCases(ctx, []string{added.PackID})
	if len(cases) != 2 {
		t.Fatalf("expected 2 cases after import, got %d", len(cases))
	}

	// Delete the manual case.
	req2, _ := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/redteam/probe-cases/"+added.Case.ID, nil)
	delResp, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete failed: %d", delResp.StatusCode)
	}
	cases, _ = db.RedTeamProbeCases(ctx, []string{added.PackID})
	if len(cases) != 1 {
		t.Fatalf("expected 1 case after delete, got %d", len(cases))
	}
}

// TestRedTeamCampaignEditAndClone verifies the create endpoint's upsert contract the UI relies on:
// posting with an existing id edits in place (incl. retain_raw_evidence), posting without an id
// creates a new campaign (the clone path).
func TestRedTeamCampaignEditAndClone(t *testing.T) {
	_, db, proxy := newRedTeamTestServer(t)
	ctx := context.Background()

	createResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns", "", map[string]any{
		"name": "orig", "scope": "provider", "execution_mode": "dry-run",
		"probe_pack_ids": []string{"rtp_data_leakage"}, "retain_raw_evidence": true,
	})
	var created struct {
		Campaign store.RedTeamCampaign `json:"campaign"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	createResp.Body.Close()
	if created.Campaign.ID == "" || !created.Campaign.RetainRawEvidence {
		t.Fatalf("create should persist retain_raw_evidence: %#v", created.Campaign)
	}

	// Edit in place: same id, flip retain flag and rename.
	editResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns", "", map[string]any{
		"id": created.Campaign.ID, "name": "orig-edited", "scope": "provider", "execution_mode": "dry-run",
		"probe_pack_ids": []string{"rtp_data_leakage"}, "retain_raw_evidence": false,
	})
	editResp.Body.Close()
	got, found, err := db.GetRedTeamCampaign(ctx, created.Campaign.ID)
	if err != nil || !found {
		t.Fatalf("edited campaign missing: %v", err)
	}
	if got.Name != "orig-edited" || got.RetainRawEvidence {
		t.Fatalf("edit did not apply (name/retain): %#v", got)
	}

	// Clone: no id → a brand-new campaign.
	cloneResp := postJSON(t, proxy.URL+"/admin/redteam/campaigns", "", map[string]any{
		"name": "orig (복제)", "scope": "provider", "execution_mode": "dry-run",
		"probe_pack_ids": []string{"rtp_data_leakage"},
	})
	var cloned struct {
		Campaign store.RedTeamCampaign `json:"campaign"`
	}
	if err := json.NewDecoder(cloneResp.Body).Decode(&cloned); err != nil {
		t.Fatal(err)
	}
	cloneResp.Body.Close()
	if cloned.Campaign.ID == created.Campaign.ID || cloned.Campaign.ID == "" {
		t.Fatalf("clone should mint a new id, got %q (orig %q)", cloned.Campaign.ID, created.Campaign.ID)
	}
	all, _ := db.ListRedTeamCampaigns(ctx, 100)
	if len(all) != 2 {
		t.Fatalf("expected 2 campaigns after edit+clone, got %d", len(all))
	}
}

// TestRedTeamSeedRebuildReplacesOldTemplates verifies the seed-version migration: an install still
// carrying the old {{variable}} placeholder cases is rebuilt to the new literal prompts on first load.
func TestRedTeamSeedRebuildReplacesOldTemplates(t *testing.T) {
	_, db, proxy := newRedTeamTestServer(t)
	ctx := context.Background()

	// Simulate an old install: a placeholder case under a default pack, seeded at an older version.
	if err := db.UpsertRedTeamProbePackWithCases(ctx, store.RedTeamProbePack{
		ID: "rtp_prompt_injection_basic", Name: "old", Category: "prompt_injection", Severity: "medium", Version: "v1", Enabled: true,
	}, []store.RedTeamProbeCase{{
		ID: "rtc_old", PackID: "rtp_prompt_injection_basic", CaseKey: "old", InputTemplate: "{{instruction_conflict}} 옛날 시드", ExpectedPolicy: "safe_completion", EvaluatorType: "rule", Severity: "medium", TargetTypes: []string{"model"},
	}}); err != nil {
		t.Fatal(err)
	}
	_ = db.UpsertAdminSetting(ctx, store.AdminSetting{Key: "redteam.seed_version", Category: "redteam", ValueJSON: "1", ValueType: "int", Source: "system"}, "test", "old")

	// GET probe-packs triggers ensureDefaultRedTeamProbePacks → rebuild.
	resp, err := http.Get(proxy.URL + "/admin/redteam/probe-packs")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	cases, err := db.RedTeamProbeCases(ctx, []string{"rtp_prompt_injection_basic"})
	if err != nil || len(cases) == 0 {
		t.Fatalf("expected rebuilt cases, got %#v (err=%v)", cases, err)
	}
	for _, c := range cases {
		if strings.Contains(c.InputTemplate, "{{") {
			t.Fatalf("rebuilt case still has a placeholder template: %q", c.InputTemplate)
		}
		if c.CaseKey == "old" {
			t.Fatalf("old placeholder case survived the rebuild")
		}
	}
}

// TestRedTeamRerunCaseLive exercises the single-case live re-run: it invokes the real (mock)
// upstream, rewrites the same result + evidence with the actual request/response, tags a redteam
// session id, and preserves the seed template — the flow behind the "원문 보관으로 실제 재실행" button.
func TestRedTeamRerunCaseLive(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"I cannot help with that request."}}],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	ctx := context.Background()

	enc, err := server.secrets.Load().Encrypt("sk-up")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: upstream.URL, EncryptedAPIKey: enc, Enabled: true, ModelPatterns: "gpt-*"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SyncRedTeamTargets(ctx, []store.RedTeamTarget{{
		ID: "rtt_x", TargetType: "model", TargetRef: "model:openai:gpt-4o", Provider: "openai", Model: "gpt-4o", RiskLevel: "medium", Enabled: true,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamProbeCase(ctx, store.RedTeamProbeCase{
		ID: "rtc_x", PackID: "rtp_x", CaseKey: "k", InputTemplate: "{{secret_extraction}} 안전 테스트", ExpectedPolicy: "refuse", Severity: "high", TargetTypes: []string{"model"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamCampaign(ctx, store.RedTeamCampaign{ID: "camp_x", Name: "c", ExecutionMode: "dry-run"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamRun(ctx, store.RedTeamRun{ID: "run_x", CampaignID: "camp_x", TargetID: "rtt_x", Status: "passed", Mode: "dry-run"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamCaseResult(ctx, store.RedTeamCaseResult{ID: "res_x", RunID: "run_x", CaseID: "rtc_x", Decision: "pass", Severity: "high"}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/admin/redteam/results/res_x/rerun", "", map[string]any{"proxy_key": "rt-key"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("rerun failed: %d %s", resp.StatusCode, body)
	}

	ev, found, err := db.RedTeamEvidenceByResult(ctx, "res_x")
	if err != nil || !found {
		t.Fatalf("evidence missing after rerun: %v", err)
	}
	if !strings.Contains(ev.RawResponse, "cannot help") {
		t.Fatalf("expected real model response captured as raw, got %q", ev.RawResponse)
	}
	if ev.RawPrompt == "" {
		t.Fatalf("expected raw prompt retained on rerun")
	}
	if sid, _ := ev.HeadersSummary["session_id"].(string); sid != "redteam:camp_x" {
		t.Fatalf("expected session_id redteam:camp_x, got %v", ev.HeadersSummary["session_id"])
	}
	if seed, _ := ev.HeadersSummary["seed_template"].(string); !strings.Contains(seed, "{{secret_extraction}}") {
		t.Fatalf("expected seed template preserved, got %v", ev.HeadersSummary["seed_template"])
	}
	// The refusal response against an expected-refuse probe should now be judged pass.
	res, _, _ := db.GetRedTeamCaseResult(ctx, "res_x")
	if res.Decision != "pass" {
		t.Fatalf("expected pass after refusal, got %q", res.Decision)
	}
}

// TestRedTeamRerunUpstreamErrorSurfaced verifies a non-200 upstream (e.g. 404 model-not-found) is
// recorded as an explicit "error" result with the upstream body captured — not silently simulated.
func TestRedTeamRerunUpstreamErrorSurfaced(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"model not found: gpt-4o"}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	ctx := context.Background()

	enc, _ := server.secrets.Load().Encrypt("sk-up")
	_ = db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: upstream.URL, EncryptedAPIKey: enc, Enabled: true, ModelPatterns: "gpt-*"})
	_ = db.SyncRedTeamTargets(ctx, []store.RedTeamTarget{{ID: "rtt_e", TargetType: "model", TargetRef: "model:openai:gpt-4o", Provider: "openai", Model: "gpt-4o", RiskLevel: "medium", Enabled: true}})
	_ = db.UpsertRedTeamProbeCase(ctx, store.RedTeamProbeCase{ID: "rtc_e", PackID: "rtp_e", CaseKey: "k", InputTemplate: "안전 테스트 프롬프트", ExpectedPolicy: "refuse", Severity: "high", TargetTypes: []string{"model"}})
	_ = db.UpsertRedTeamCampaign(ctx, store.RedTeamCampaign{ID: "camp_e", Name: "c", ExecutionMode: "dry-run"})
	_ = db.InsertRedTeamRun(ctx, store.RedTeamRun{ID: "run_e", CampaignID: "camp_e", TargetID: "rtt_e", Status: "passed", Mode: "dry-run"})
	_ = db.InsertRedTeamCaseResult(ctx, store.RedTeamCaseResult{ID: "res_e", RunID: "run_e", CaseID: "rtc_e", Decision: "pass", Severity: "high"})

	resp := postJSON(t, proxy.URL+"/admin/redteam/results/res_e/rerun", "", map[string]any{"proxy_key": "rt-key"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("rerun should succeed at the API layer even when upstream errors: %d %s", resp.StatusCode, body)
	}
	res, _, _ := db.GetRedTeamCaseResult(ctx, "res_e")
	if res.Decision != "error" {
		t.Fatalf("expected error decision on 404 upstream, got %q", res.Decision)
	}
	ev, ok, _ := db.RedTeamEvidenceByResult(ctx, "res_e")
	if !ok || !strings.Contains(ev.MaskedResponse, "404") {
		t.Fatalf("expected upstream 404 captured in evidence, got %#v", ev.MaskedResponse)
	}
}

// TestRedTeamRawEvidenceRoundTrip verifies the campaign opt-in flag and raw evidence persistence.
func TestRedTeamRawEvidenceRoundTrip(t *testing.T) {
	_, db, _ := newRedTeamTestServer(t)
	ctx := context.Background()

	c := store.RedTeamCampaign{ID: "rtc_raw", Name: "raw", RetainRawEvidence: true}
	if err := db.UpsertRedTeamCampaign(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetRedTeamCampaign(ctx, "rtc_raw")
	if err != nil || !found || !got.RetainRawEvidence {
		t.Fatalf("retain_raw_evidence flag did not round-trip: found=%v %#v (err=%v)", found, got, err)
	}

	ev := store.RedTeamEvidence{
		ID: "rtev_raw", ResultID: "res_raw", MaskedPrompt: "masked", MaskedResponse: "masked",
		RawPrompt: "실제 요청 원문", RawResponse: "실제 응답 원문", ExportHash: "h",
	}
	if err := db.InsertRedTeamEvidence(ctx, ev); err != nil {
		t.Fatal(err)
	}
	back, found, err := db.RedTeamEvidenceByResult(ctx, "res_raw")
	if err != nil || !found {
		t.Fatalf("evidence not found: %v", err)
	}
	if back.RawPrompt != "실제 요청 원문" || back.RawResponse != "실제 응답 원문" {
		t.Fatalf("raw evidence did not round-trip: %#v", back)
	}
}
