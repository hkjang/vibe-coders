package proxy

import "testing"

// The agent route's tool allowlist.
//
// A route can restrict which MCP tools it exposes. The subtlety is that the same filtered
// object does two jobs: its `tools` slice is what the model is shown, and its `routes` map
// is what a tool call is looked up in when the model answers. Filtering only the first
// would leave a tool that is never advertised still callable — and a model can emit a call
// for a tool it was not offered, whether because it hallucinated the name or because
// something in the prompt told it to.
//
// So these tests check the routes map as carefully as the tools list. The two staying in
// step is the property; an optimisation that filtered one and not the other would look
// harmless and would not be.

func toolsetFixture() mcpAgentToolset {
	tool := func(name string) map[string]any {
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	}
	return mcpAgentToolset{
		tools: []map[string]any{tool("wiki_search"), tool("crm_search"), tool("crm_delete")},
		routes: map[string]mcpAgentRoute{
			"wiki_search": {upstreamID: "u1", upstreamName: "wiki", bareTool: "search", namespaced: "wiki/search"},
			"crm_search":  {upstreamID: "u2", upstreamName: "crm", bareTool: "search", namespaced: "crm/search"},
			"crm_delete":  {upstreamID: "u2", upstreamName: "crm", bareTool: "delete", namespaced: "crm/delete"},
		},
	}
}

func toolNamesOf(ts mcpAgentToolset) []string {
	var out []string
	for _, t := range ts.tools {
		fn, _ := t["function"].(map[string]any)
		if name, _ := fn["name"].(string); name != "" {
			out = append(out, name)
		}
	}
	return out
}

func TestToolAllowlistFiltersWhatIsCallableNotJustWhatIsOffered(t *testing.T) {
	ts := filterAgentToolset(toolsetFixture(), []string{"crm/search"})

	if names := toolNamesOf(ts); len(names) != 1 || names[0] != "crm_search" {
		t.Fatalf("the model was offered %v, want only crm_search", names)
	}
	// The security-relevant half: a call for a tool that was not offered must not resolve.
	for _, notAllowed := range []string{"crm_delete", "wiki_search"} {
		if _, ok := ts.routes[notAllowed]; ok {
			t.Errorf("%q was excluded from the offered tools but is still routable, so a model "+
				"that calls it anyway reaches the upstream", notAllowed)
		}
	}
	if _, ok := ts.routes["crm_search"]; !ok {
		t.Error("the allowed tool is not routable, so the route cannot use what it exposes")
	}
}

// A bare name matches that tool on every server, which is the documented convenience and
// worth pinning as a decision rather than left to be discovered: allowing "search" grants
// it on all upstreams, not just the one the operator had in mind.
func TestBareToolNameMatchesEveryServer(t *testing.T) {
	ts := filterAgentToolset(toolsetFixture(), []string{"search"})
	names := toolNamesOf(ts)
	if len(names) != 2 {
		t.Fatalf("a bare tool name matched %v; it is documented to match that tool on every "+
			"server, so both search tools should be present", names)
	}
	if _, ok := ts.routes["crm_delete"]; ok {
		t.Error("a bare name for search also exposed delete")
	}
}

// An empty allowlist means "everything the servers offer", not "nothing".
func TestEmptyAllowlistExposesEverything(t *testing.T) {
	ts := filterAgentToolset(toolsetFixture(), nil)
	if len(toolNamesOf(ts)) != 3 || len(ts.routes) != 3 {
		t.Errorf("an empty allowlist should expose all three tools, got %v / %d routes",
			toolNamesOf(ts), len(ts.routes))
	}
}

// A name that matches nothing yields an empty set rather than falling back to everything —
// the failure mode where a typo in the allowlist quietly opens the route up.
func TestUnknownToolNameExposesNothing(t *testing.T) {
	ts := filterAgentToolset(toolsetFixture(), []string{"crm/purge"})
	if len(toolNamesOf(ts)) != 0 || len(ts.routes) != 0 {
		t.Errorf("an allowlist naming no real tool exposed %v / %d routes; a typo must not "+
			"open the route up", toolNamesOf(ts), len(ts.routes))
	}
}
