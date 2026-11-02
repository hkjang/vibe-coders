//go:build linux

package proxy

import (
	"encoding/json"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedBrowserMcpRiskFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	now := time.Now().UTC()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{ID: "browser_mcp_risk", TraceID: "browser_mcp_risk", StatusCode: 200, CreatedAt: now},
		Tools:   []store.ToolInvocation{{ID: "browser_mcp_tool", RequestID: "browser_mcp_risk", TraceID: "browser_mcp_risk", ServerLabel: "browser-risk-server", ToolName: "write_record", Source: "call", IsMCP: true, CreatedAt: now}},
	}); err != nil {
		t.Fatal("MCP risk browser fixture could not be seeded")
	}
	if err := db.UpsertToolRiskProfile(t.Context(), store.ToolRiskProfile{ID: "browser_risk_profile", ServerLabel: "browser-risk-server", ToolName: "write_record", RiskLevel: "high", Action: "block", Note: "browser baseline"}); err != nil {
		t.Fatal("MCP risk profile could not be seeded")
	}
}

func assertBrowserMcpRisk(t *testing.T, db *store.SQLStore) {
	t.Helper()
	profile, found, err := db.ToolRiskProfile(t.Context(), "browser-risk-server", "write_record")
	if err != nil || !found || profile.RiskLevel != "critical" || profile.Action != "block" || profile.Note != "browser reviewed" {
		t.Fatal("reviewed MCP risk was not persisted")
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("MCP risk audit lookup failed")
	}
	count := 0
	for _, event := range audits {
		if event.Action != "mcp.tool_risk.upsert" {
			continue
		}
		var after store.ToolRiskProfile
		if json.Unmarshal([]byte(event.AfterValue), &after) != nil {
			t.Fatal("invalid MCP risk audit")
		}
		if after.ServerLabel == "browser-risk-server" && after.ToolName == "write_record" {
			if after.RiskLevel != "critical" || after.Action != "block" || after.Note != "browser reviewed" {
				t.Fatal("MCP audit does not match reviewed write")
			}
			count++
		}
	}
	if count != 1 {
		t.Fatal("MCP risk must be written and audited once")
	}
}

func assertBrowserMcpPolicy(t *testing.T, db *store.SQLStore) {
	t.Helper()
	const server = "browser-policy-reviewed"
	policies, err := db.ListMCPPolicies(t.Context())
	if err != nil {
		t.Fatal("MCP policy verification lookup failed")
	}
	for _, policy := range policies {
		if policy.ServerLabel == server {
			t.Fatal("reviewed MCP policy was not deleted")
		}
	}
	flag, found, err := db.GetFlag(t.Context(), "mcp_allowlist_enabled")
	if err != nil || !found || flag.Value != "false" {
		t.Fatal("reviewed MCP allowlist was not disabled")
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("MCP policy audit lookup failed")
	}
	counts := map[string]int{}
	for _, event := range audits {
		switch event.Action {
		case "mcp.policy.upsert":
			var policy store.MCPPolicy
			if json.Unmarshal([]byte(event.AfterValue), &policy) != nil {
				t.Fatal("invalid MCP policy audit")
			}
			if policy.ServerLabel == server {
				if policy.Mode == "block" && policy.Note == "browser policy baseline" {
					counts["create"]++
				} else if policy.Mode == "warn" && policy.Note == "browser policy reviewed" {
					counts["edit"]++
				} else {
					t.Fatal("MCP policy audit does not match reviewed change")
				}
			}
		case "mcp.policy.delete":
			var policy store.MCPPolicy
			if json.Unmarshal([]byte(event.BeforeValue), &policy) != nil {
				t.Fatal("invalid MCP policy deletion audit")
			}
			if policy.ServerLabel == server {
				counts["delete"]++
			}
		case "mcp.allowlist":
			var state struct {
				Enabled *bool `json:"enabled"`
			}
			if json.Unmarshal([]byte(event.AfterValue), &state) != nil || state.Enabled == nil {
				t.Fatal("invalid MCP allowlist audit")
			}
			if *state.Enabled {
				counts["enable"]++
			} else {
				counts["disable"]++
			}
		}
	}
	for _, action := range []string{"create", "edit", "delete", "enable", "disable"} {
		if counts[action] != 1 {
			t.Fatal("each reviewed MCP policy operation must be audited exactly once")
		}
	}
}
