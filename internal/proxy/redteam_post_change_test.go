package proxy

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestClassifyPostChangeRedTeam(t *testing.T) {
	tests := []struct {
		name       string
		action     string
		before     string
		after      string
		want       bool
		scope      string
		ref        string
		provider   string
		mcp        string
		targetType string
	}{
		{
			name: "provider", action: "provider.upsert",
			after: `{"name":"openai","base_url":"https://api.openai.com","api_key_configured":true}`,
			want:  true, scope: "provider", ref: "openai", provider: "openai",
		},
		{
			name: "mcp tool risk", action: "mcp.tool_risk.upsert",
			after: `{"server_label":"github","tool_name":"create_issue","risk_level":"high"}`,
			want:  true, scope: "mcp", ref: "github/create_issue", mcp: "github",
		},
		{
			name: "text2sql schema", action: "text2sql.schema.upsert",
			after: `{"name":"finance","team":"analytics"}`,
			want:  true, scope: "text2sql", ref: "finance", targetType: "text2sql",
		},
		{
			name: "workflow", action: "workflow.publish", before: "wf_ops",
			after: `{"version":"v3"}`,
			want:  true, scope: "workflow", ref: "wf_ops", targetType: "workflow",
		},
		{name: "redteam recursion excluded", action: "redteam.campaign.run", want: false},
		{name: "read-only text2sql operation excluded", action: "text2sql.golden.run", want: false},
		{name: "unrelated setting excluded", action: "setting.update", before: "carbon.pue", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := classifyPostChangeRedTeam(tt.action, tt.before, tt.after)
			if ok != tt.want {
				t.Fatalf("matched=%v, want %v: %#v", ok, tt.want, got)
			}
			if !ok {
				return
			}
			if got.Scope != tt.scope || got.Ref != tt.ref || got.Provider != tt.provider ||
				got.MCPUpstream != tt.mcp || got.TargetType != tt.targetType {
				t.Fatalf("unexpected spec: %#v", got)
			}
			if len(got.ProbePacks) == 0 {
				t.Fatal("eligible change must select at least one probe pack")
			}
		})
	}
}

func TestSelectPostChangeRedTeamTargetsIsBoundedAndBalanced(t *testing.T) {
	targets := []store.RedTeamTarget{
		{ID: "app", TargetType: "ai_app", TargetRef: "ai_app:a", Enabled: true},
		{ID: "mcp-tool", TargetType: "mcp_tool", TargetRef: "mcp_tool:m/t", MCPUpstream: "m", Enabled: true},
		{ID: "provider", TargetType: "provider", TargetRef: "provider:p", Provider: "p", Enabled: true},
		{ID: "model", TargetType: "model", TargetRef: "model:p:m", Provider: "p", Enabled: true},
		{ID: "text2sql", TargetType: "text2sql", TargetRef: "text2sql:vibe/text2sql", Enabled: true},
		{ID: "workflow", TargetType: "workflow", TargetRef: "workflow:w", Enabled: true},
	}
	got := selectPostChangeRedTeamTargets(targets, postChangeRedTeamSpec{Scope: "all"}, 4)
	want := []string{"provider", "model", "mcp-tool", "text2sql"}
	if len(got) != len(want) {
		t.Fatalf("selected %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("selected %v, want %v", got, want)
		}
	}

	exact := selectPostChangeRedTeamTargets(targets, postChangeRedTeamSpec{Scope: "mcp", MCPUpstream: "m"}, 10)
	if len(exact) != 1 || exact[0] != "mcp-tool" {
		t.Fatalf("exact MCP selection = %v", exact)
	}
}

func TestPostChangeRedTeamCreatesSimulationAndDeduplicates(t *testing.T) {
	redteamKillSwitch.Store(false)
	t.Cleanup(func() { redteamKillSwitch.Store(false) })

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "post-change.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		logger.Stop(context.Background())
		db.Close()
	})
	cfg := testConfig("http://upstream.local", "upstream-secret")
	cfg.RedTeam = config.RedTeamConfig{
		PostChangeEnabled:    true,
		PostChangeCooldown:   time.Hour,
		PostChangeMaxTargets: 5,
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	provider := store.ProviderConfig{
		Name: "acme", BaseURL: "http://acme.internal", Enabled: true, ModelPatterns: "acme-chat,acme-code",
	}
	if err := db.UpsertProvider(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/admin/providers", nil)
	req.Header.Set("Authorization", "Bearer post-change-admin")
	after := providerAuditJSON(provider)

	server.auditAdmin(req, "provider.upsert", "", after)
	campaigns, err := db.ListRedTeamCampaigns(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(campaigns) != 1 {
		t.Fatalf("campaign count=%d, want 1: %#v", len(campaigns), campaigns)
	}
	campaign := campaigns[0]
	if campaign.TriggerSource != "post-change" || campaign.TriggerAction != "provider.upsert" ||
		campaign.TriggerRef != "acme" || campaign.ExecutionMode != "dry-run" || campaign.Status != "completed" {
		t.Fatalf("unexpected automatic campaign: %#v", campaign)
	}
	if campaign.TriggerFingerprint == "" {
		t.Fatal("post-change campaign must retain a private dedupe fingerprint")
	}
	runs, err := db.ListRedTeamRuns(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) == 0 {
		t.Fatal("post-change campaign should execute a simulation run")
	}
	for _, run := range runs {
		if run.CampaignID != campaign.ID || run.Mode != "dry-run" {
			t.Fatalf("unexpected post-change run: %#v", run)
		}
	}

	// The same successful mutation inside the cooldown reuses the first security regression.
	server.auditAdmin(req, "provider.upsert", "", after)
	campaigns, err = db.ListRedTeamCampaigns(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(campaigns) != 1 {
		t.Fatalf("duplicate change created %d campaigns, want 1", len(campaigns))
	}

	// A materially different safe audit representation gets its own regression campaign.
	provider.ModelPatterns = "acme-chat,acme-code,acme-reasoning"
	server.auditAdmin(req, "provider.upsert", after, providerAuditJSON(provider))
	campaigns, err = db.ListRedTeamCampaigns(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(campaigns) != 2 {
		t.Fatalf("changed provider state created %d campaigns, want 2", len(campaigns))
	}
}

func TestPostChangeRedTeamDisabledLeavesNoCampaign(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "disabled.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		logger.Stop(context.Background())
		db.Close()
	})
	server, err := NewServer(testConfig("http://upstream.local", "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.auditAdmin(httptest.NewRequest("POST", "/admin/providers", nil), "provider.upsert", "", `{"name":"test"}`)
	campaigns, err := db.ListRedTeamCampaigns(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(campaigns) != 0 {
		t.Fatalf("disabled trigger created campaigns: %#v", campaigns)
	}
}
