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
