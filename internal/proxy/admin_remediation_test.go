package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestExecutableRemediationsWhitelist(t *testing.T) {
	// Reversible toggles must be executable; advisory action types must NOT be.
	mustExec := []string{"gateway_kill", "gateway_resume", "text2sql_kill", "text2sql_resume",
		"provider_disable", "provider_enable", "mcp_tool_block", "mcp_tool_allow"}
	for _, a := range mustExec {
		if !executableRemediations[a] {
			t.Errorf("%q should be executable", a)
		}
	}
	for _, a := range []string{"budget_cap_advisory", "policy_review_advisory", "", "drop_database"} {
		if executableRemediations[a] {
			t.Errorf("%q must NOT be executable", a)
		}
	}
}

func TestTernaryStr(t *testing.T) {
	if ternaryStr(true, "a", "b") != "a" || ternaryStr(false, "a", "b") != "b" {
		t.Fatal("ternaryStr wrong")
	}
}

func TestPickWorstMCPTool(t *testing.T) {
	if pickWorstMCPTool(nil) != nil {
		t.Fatal("nil input should yield nil")
	}
	tools := []store.MCPToolStat{
		{ServerLabel: "s", ToolName: "low", Calls: 100, ErrorRate: 0.1},
		{ServerLabel: "s", ToolName: "high", Calls: 50, ErrorRate: 0.4},
		{ServerLabel: "s", ToolName: "tiny", Calls: 2, ErrorRate: 0.9}, // below min calls, ignored
	}
	w := pickWorstMCPTool(tools)
	if w == nil || w.ToolName != "high" {
		t.Fatalf("expected worst='high', got %+v", w)
	}
}
