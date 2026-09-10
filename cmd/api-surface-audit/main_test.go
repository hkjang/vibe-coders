package main

import "testing"

func TestPathCovered(t *testing.T) {
	routes := []string{"/v1/models", "/v1/apps/", "/mcp/gateway", "/me/connection-doctor", "/v1/"}
	cases := []struct {
		path string
		want bool
	}{
		{"/v1/models", true}, // exact
		{"/v1/apps/${encodeURIComponent(appId)}/run", true}, // prefix handler + template param
		{"/v1/apps/", true},                    // the prefix itself
		{"/mcp/gateway", true},                 // exact
		{"/me/connection-doctor", true},        // exact
		{"/v1/chat/completions", true},         // covered by "/v1/" prefix
		{"/v1/nonexistent-but-under-v1", true}, // also under "/v1/"
		{"/admin/secret", false},               // not served by any client route here
	}
	for _, c := range cases {
		if got := pathCovered(c.path, routes); got != c.want {
			t.Errorf("pathCovered(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestExtractors(t *testing.T) {
	server := `mux.HandleFunc("/v1/apps/", h)` + "\n" + `mux.HandleFunc( "/mcp/gateway" , h)`
	if r := extractMatches(reHandleFunc, server); len(r) != 2 || r[0] != "/v1/apps/" || r[1] != "/mcp/gateway" {
		t.Fatalf("server routes = %v", r)
	}
	openapi := `{"/v1/apps/{id}/run", []string{"post"}, "apps", "...", false},`
	if d := extractMatches(reOpenAPI, openapi); len(d) != 1 || d[0] != "/v1/apps/{id}/run" {
		t.Fatalf("openapi paths = %v", d)
	}
	cliGo := `cfg.do(http.MethodPost, "/v1/apps/"+appID+"/run", nil)` + "\n" + `cfg.do("GET", "/me/connection-doctor", nil)`
	if c := extractMatches(reClientGo, cliGo); len(c) != 2 {
		t.Fatalf("cli paths = %v", c)
	}
	sdkTS := "this.req(\"POST\", `/v1/apps/${id}/run`, {})\nthis.req(\"GET\", \"/v1/models\")"
	got := extractMatches(reClientTS, sdkTS)
	if len(got) != 2 {
		t.Fatalf("sdk paths = %v", got)
	}
}

// The real repo sources must keep the CLI/SDK contract intact (no cli_only/sdk_only).
func TestBuildReportContractIntact(t *testing.T) {
	server := []string{`
		mux.HandleFunc("/v1/chat/completions", h)
		mux.HandleFunc("/v1/models", h)
		mux.HandleFunc("/v1/apps/", h)
		mux.HandleFunc("/v1/workflows/", h)
		mux.HandleFunc("/mcp/gateway", h)
		mux.HandleFunc("/me/connection-doctor", h)
	`}
	openapi := `{"/v1/models", []string{"get"}, "x", "y", false},`
	cli := `do("GET","/v1/models", nil); do("POST","/mcp/gateway", nil); do("POST","/me/connection-doctor", nil)`
	sdk := "req(\"POST\", \"/v1/chat/completions\"); req(\"POST\", `/v1/apps/${id}/run`); req(\"POST\", `/v1/workflows/${id}/run`); req(\"POST\", \"/mcp/gateway\")"
	rep := buildReport(server, openapi, cli, sdk)
	if len(rep.CLIOnly) != 0 {
		t.Errorf("expected no cli_only, got %v", rep.CLIOnly)
	}
	if len(rep.SDKOnly) != 0 {
		t.Errorf("expected no sdk_only, got %v", rep.SDKOnly)
	}
	// A SDK path with no server route must be flagged.
	rep2 := buildReport([]string{`mux.HandleFunc("/v1/models", h)`}, "", "", "req(\"POST\", \"/v1/ghost\")")
	if len(rep2.SDKOnly) != 1 || rep2.SDKOnly[0] != "/v1/ghost" {
		t.Fatalf("expected /v1/ghost flagged as sdk_only, got %v", rep2.SDKOnly)
	}
}

func TestNormalizePath(t *testing.T) {
	cases := map[string]string{
		"/admin/settings/by-key/{}":    "/admin/settings/by-key/{}", // legacy concatenation, folded
		"/admin/settings/by-key/{key}": "/admin/settings/by-key/{}", // React template
		"/admin/users":                 "/admin/users",              // no variable part
		"/admin/requests/{id}/trace":   "/admin/requests/{}/trace",  // a sub-action past the id
		"/admin/teams/{id}/members/":   "/admin/teams/{}/members",   // trailing slash dropped
	}
	for in, want := range cases {
		if got := normalizePath(in); got != want {
			t.Errorf("normalizePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// The legacy console writes a path parameter by concatenation. Reading only the first string
// literal stops at the prefix and counts every sub-action under it as covered — the bug that let
// the request trace screen stay missing from /app while this audit reported no gaps.
func TestLegacyConsolePathsFoldsConcatenation(t *testing.T) {
	src := `
		api('/admin/requests?limit=20')
		api('/admin/requests/' + encodeURIComponent(id) + '/trace')
		api('/admin/requests/' + encodeURIComponent(id) + '/note')
		api('/admin/settings/by-key/' + encodeURIComponent(key))
	`
	got := uniqueSorted(legacyConsolePaths(src))
	// The two concatenated calls fold into their own endpoints rather than collapsing onto
	// the "/admin/requests/" prefix they start from.
	want := []string{
		"/admin/requests",
		"/admin/requests/{}/note",
		"/admin/requests/{}/trace",
		"/admin/settings/by-key/",
	}
	if len(got) != len(want) {
		t.Fatalf("legacy paths = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("legacy paths = %v, want %v", got, want)
		}
	}
}

func TestConsoleCovered(t *testing.T) {
	app := []string{
		"/admin/users",
		"/admin/settings/by-key/{key}",
		"/admin/requests/{id}/note",
	}
	cases := []struct {
		legacy string
		want   bool
	}{
		{"/admin/users", true},               // same endpoint
		{"/admin/settings/by-key/", true},    // concatenation vs template spelling
		{"/admin/requests/", true},           // the app path continues past a legacy prefix
		{"/admin/requests/{}/note", true},    // the same sub-action, both spellings folded
		{"/admin/requests/{}/trace", false},  // a sub-action only the legacy console calls
		{"/admin/legacy-only-widget", false}, // only the legacy console calls it
		{"/admin/users-report", false},       // shares a prefix but is a different endpoint
	}
	for _, c := range cases {
		if got := consoleCovered(c.legacy, app); got != c.want {
			t.Errorf("consoleCovered(%q) = %v, want %v", c.legacy, got, c.want)
		}
	}
}

// A feature added to the legacy console alone reopens the migration gap, so it must fail the audit.
func TestConsoleParityFlagsLegacyOnlyEndpoint(t *testing.T) {
	legacyUI := `
		api('/admin/users?limit=50')
		api('/admin/settings/by-key/' + encodeURIComponent(key))
		api('/admin/legacy-only-widget')
	`
	appUI := []string{
		`endpoint("GET", "/admin/users", schema)`,
		"const byKey = `/admin/settings/by-key/{key}`;",
	}
	legacy, app, gaps := consoleParity(legacyUI, appUI)
	if len(legacy) != 3 {
		t.Fatalf("legacy console paths = %v", legacy)
	}
	if len(app) != 2 {
		t.Fatalf("app console paths = %v", app)
	}
	if len(gaps) != 1 || gaps[0] != "/admin/legacy-only-widget" {
		t.Fatalf("console parity gaps = %v, want only /admin/legacy-only-widget", gaps)
	}
}
