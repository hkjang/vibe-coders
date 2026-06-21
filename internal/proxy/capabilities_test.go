package proxy

import "testing"

func TestCapabilityRegistryIntegrity(t *testing.T) {
	if len(capabilityRegistry) == 0 {
		t.Fatal("capability registry is empty")
	}
	seen := map[string]bool{}
	for _, c := range capabilityRegistry {
		if c.Key == "" || c.Name == "" || c.Description == "" || c.Group == "" {
			t.Errorf("capability %q missing required field: %+v", c.Key, c)
		}
		if seen[c.Key] {
			t.Errorf("duplicate capability key: %s", c.Key)
		}
		seen[c.Key] = true
	}
	// A few keys the roadmap explicitly requires.
	for _, want := range []string{"text2sql", "mcp_gateway", "skill_studio", "runtime_settings", "okf", "personalization", "clickhouse_dw", "routing", "governance"} {
		if !seen[want] {
			t.Errorf("registry missing required capability: %s", want)
		}
	}
}
