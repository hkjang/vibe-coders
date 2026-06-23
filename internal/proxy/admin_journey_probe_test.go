package proxy

import "testing"

func TestJourneyDefsValidSteps(t *testing.T) {
	valid := map[string]bool{"models": true, "mcp_init": true, "mcp_tools": true}
	if len(journeyDefs) == 0 {
		t.Fatal("journeyDefs must not be empty")
	}
	for client, steps := range journeyDefs {
		if len(steps) == 0 {
			t.Errorf("client %q has no steps", client)
		}
		for _, s := range steps {
			if !valid[s] {
				t.Errorf("client %q has unknown step %q", client, s)
			}
		}
	}
	// MCP clients must include the MCP handshake steps.
	for _, c := range []string{"roo", "cline", "claude-desktop-mcp"} {
		steps := journeyDefs[c]
		hasInit, hasTools := false, false
		for _, s := range steps {
			if s == "mcp_init" {
				hasInit = true
			}
			if s == "mcp_tools" {
				hasTools = true
			}
		}
		if !hasInit || !hasTools {
			t.Errorf("MCP client %q must probe mcp_init and mcp_tools, got %v", c, steps)
		}
	}
}
