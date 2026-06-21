package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestPolicyAdvisorDedup(t *testing.T) {
	rules := []store.PolicyRule{
		{Conditions: map[string]any{"model": "gpt-4"}, Actions: map[string]any{"require_approval": true}},
		{Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"o1-pro"}}},
		{Conditions: map[string]any{"mcp_tool": "shell"}, Actions: map[string]any{"block": true}},
		{Conditions: map[string]any{}, Actions: map[string]any{"secret_action": "block"}},
	}
	if !ruleCoversModel(rules, "gpt-4") {
		t.Error("model condition should be detected")
	}
	if !ruleCoversModel(rules, "o1-pro") {
		t.Error("deny_models membership should be detected")
	}
	if ruleCoversModel(rules, "claude-3") {
		t.Error("unrelated model must not be covered")
	}
	if !ruleCoversMCPTool(rules, "shell") {
		t.Error("mcp_tool condition should be detected")
	}
	if ruleCoversMCPTool(rules, "fetch") {
		t.Error("unrelated tool must not be covered")
	}
	if !ruleHasSecretBlock(rules) {
		t.Error("secret_action=block should be detected")
	}
	if ruleHasSecretBlock(rules[:1]) {
		t.Error("no secret block here")
	}
}
