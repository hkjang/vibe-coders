// Command api-surface-audit statically compares the API surface that clients (the cmd/vibe CLI
// and the TypeScript SDK) and the OpenAPI catalog expect against the routes the server actually
// registers. It exists so a server route rename can't silently break the published client
// contract: run `go run ./cmd/api-surface-audit` (CI fails on a contract break).
//
// It also audits console parity: every /admin endpoint the legacy console calls must also be
// bound in the React console's API layer under /app. That is endpoint coverage, not a claim about
// which control invokes it — but it is enough to catch the regression that matters, a feature
// added to the legacy console alone, quietly reopening the migration gap the /app port closed.
//
// It is deliberately a static analyzer (no server boot): it greps mux.HandleFunc registrations,
// the apiEndpoints OpenAPI catalog, and the path literals in the CLI/SDK/console sources.
package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type auditReport struct {
	ServerRoutes   []string `json:"server_routes"`
	CLIPaths       []string `json:"cli_paths"`
	SDKPaths       []string `json:"sdk_paths"`
	OpenAPIPaths   []string `json:"openapi_paths"`
	CLIOnly        []string `json:"cli_only_methods"`    // CLI calls a path no server route serves (FAIL)
	SDKOnly        []string `json:"sdk_only_methods"`    // SDK calls a path no server route serves (FAIL)
	OpenAPIMissing []string `json:"openapi_missing"`     // server route absent from the OpenAPI catalog (warn)
	StaleDocs      []string `json:"undocumented_routes"` // OpenAPI entry with no matching server route (warn)

	LegacyConsolePaths []string `json:"legacy_console_paths"`
	AppConsolePaths    []string `json:"app_console_paths"`
	ConsoleParityGaps  []string `json:"console_parity_gaps"` // legacy console endpoint the React console never binds (FAIL)
}

var (
	reHandleFunc = regexp.MustCompile(`mux\.HandleFunc\(\s*"([^"]+)"`)
	reOpenAPI    = regexp.MustCompile(`\{"(/[^"]*)",\s*\[\]string\{`)
	reClientGo   = regexp.MustCompile(`"(/(?:v1|me|mcp)[^"]*)"`)
	reClientTS   = regexp.MustCompile("[\"`](/(?:v1|me|mcp)[^\"`]*)[\"`]")
	// Console endpoints. The legacy console is JavaScript inside a Go string literal and quotes
	// its paths with ', so it never uses backticks; the React sources use all three quote styles.
	reLegacyAdmin = regexp.MustCompile(`['"](/admin/[^'"?#]*)`)
	// "$" ends the literal part of a React template ("`/admin/export.csv${query}`"), the same
	// way "?" ends it at a query string.
	reAppAdmin = regexp.MustCompile("['\"`](/admin/[^'\"`?#$]*)")
	// " + <expression> + '/rest'" — the legacy console's way of writing a path parameter.
	reLegacyConcat = regexp.MustCompile(`\A\s*\+\s*[^+']+?\s*\+\s*'(/[^'"?#]*)'`)
	reParamSegment = regexp.MustCompile(`\{[^}]*\}`)
)

// concatLookahead bounds how far past a path literal the audit reads for a "+ id + '/rest'"
// continuation. One argument list is far shorter than this.
const concatLookahead = 200

func uniqueSorted(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func extractMatches(re *regexp.Regexp, src string) []string {
	out := []string{}
	for _, m := range re.FindAllStringSubmatch(src, -1) {
		out = append(out, m[1])
	}
	return out
}

// pathCovered reports whether a client path is served by some registered route. Routes ending in
// "/" are prefix handlers (e.g. "/v1/apps/" serves "/v1/apps/{id}/run"); others match exactly. A
// client path may carry template params (${id}) — the static prefix is enough to match.
func pathCovered(clientPath string, routes []string) bool {
	for _, r := range routes {
		if r == clientPath {
			return true
		}
		if strings.HasSuffix(r, "/") && strings.HasPrefix(clientPath, r) {
			return true
		}
	}
	return false
}

// routeDocumented reports whether a registered route is covered by an OpenAPI catalog entry.
func routeDocumented(route string, docs []string) bool {
	trimmed := strings.TrimRight(route, "/")
	for _, d := range docs {
		if d == route || d == trimmed {
			return true
		}
		if strings.HasSuffix(route, "/") && strings.HasPrefix(d, route) {
			return true // a documented param path lives under this prefix handler
		}
	}
	return false
}

// docRegistered reports whether an OpenAPI entry maps to some registered route.
func docRegistered(doc string, routes []string) bool {
	// Strip any {param} suffix to the static prefix for prefix-handler matching.
	prefix := doc
	if i := strings.Index(doc, "{"); i >= 0 {
		prefix = doc[:i]
	}
	for _, r := range routes {
		if r == doc {
			return true
		}
		if strings.HasSuffix(r, "/") && (strings.HasPrefix(doc, r) || strings.HasPrefix(prefix, r)) {
			return true
		}
		if r == strings.TrimRight(prefix, "/") {
			return true
		}
	}
	return false
}

// normalizePath rewrites every variable segment to a single "{}" so the two consoles' spellings
// of the same endpoint compare equal: the React console writes a template
// ("/admin/requests/{id}/trace") and the legacy console concatenates
// ("/admin/requests/" + encodeURIComponent(id) + "/trace"), which legacyConsolePaths has already
// folded into the same shape.
func normalizePath(path string) string {
	return strings.TrimRight(reParamSegment.ReplaceAllString(path, "{}"), "/")
}

// legacyConsolePaths extracts the /admin endpoints the legacy console calls, folding a
// concatenated path back into one endpoint. Reading only the first string literal would stop at
// "/admin/requests/" and count every sub-action under it as covered, which is how the request
// trace and links screens stayed missing from /app while this audit reported no gaps.
func legacyConsolePaths(src string) []string {
	out := []string{}
	for _, m := range reLegacyAdmin.FindAllStringSubmatchIndex(src, -1) {
		path := src[m[2]:m[3]]
		// reLegacyAdmin stops before the closing quote; step over it so the continuation
		// below starts at the " + expr + " that follows.
		pos := m[1]
		if pos < len(src) && (src[pos] == '\'' || src[pos] == '"') {
			pos++
		}
		for {
			tail := src[pos:min(pos+concatLookahead, len(src))]
			cont := reLegacyConcat.FindStringSubmatchIndex(tail)
			if cont == nil {
				break
			}
			path = strings.TrimRight(path, "/") + "/{}" + tail[cont[2]:cont[3]]
			pos += cont[1]
		}
		out = append(out, path)
	}
	return out
}

// consoleCovered reports whether the React console binds a legacy console endpoint. An app path
// covers a legacy one when the normalized paths are equal, or when the app path continues past a
// legacy path that stopped at a prefix (the legacy console builds "/admin/x/" + id with nothing
// after it, which any "/admin/x/{}" binding answers).
func consoleCovered(legacyPath string, appPaths []string) bool {
	want := normalizePath(legacyPath)
	for _, a := range appPaths {
		app := normalizePath(a)
		if app == want || strings.HasPrefix(app, want+"/") {
			return true
		}
	}
	return false
}

// consoleParity extracts both consoles' /admin endpoints and returns the legacy ones the React
// console never binds. The React console may bind more (it does — its screens split work the
// legacy console did in one view); only the reverse direction is a migration gap.
func consoleParity(legacyUISrc string, appUISrcs []string) (legacy, app, gaps []string) {
	legacy = uniqueSorted(legacyConsolePaths(legacyUISrc))
	appPaths := []string{}
	for _, s := range appUISrcs {
		appPaths = append(appPaths, extractMatches(reAppAdmin, s)...)
	}
	app = uniqueSorted(appPaths)
	for _, p := range legacy {
		if !consoleCovered(p, app) {
			gaps = append(gaps, p)
		}
	}
	return legacy, app, gaps
}

func buildReport(serverSrcs []string, openapiSrc, cliSrc, sdkSrc string) auditReport {
	routes := []string{}
	for _, s := range serverSrcs {
		routes = append(routes, extractMatches(reHandleFunc, s)...)
	}
	routes = uniqueSorted(routes)
	docs := uniqueSorted(extractMatches(reOpenAPI, openapiSrc))
	cli := uniqueSorted(extractMatches(reClientGo, cliSrc))
	sdk := uniqueSorted(extractMatches(reClientTS, sdkSrc))

	rep := auditReport{ServerRoutes: routes, CLIPaths: cli, SDKPaths: sdk, OpenAPIPaths: docs}
	for _, p := range cli {
		if !pathCovered(p, routes) {
			rep.CLIOnly = append(rep.CLIOnly, p)
		}
	}
	for _, p := range sdk {
		if !pathCovered(p, routes) {
			rep.SDKOnly = append(rep.SDKOnly, p)
		}
	}
	for _, r := range routes {
		if !routeDocumented(r, docs) {
			rep.OpenAPIMissing = append(rep.OpenAPIMissing, r)
		}
	}
	for _, d := range docs {
		if !docRegistered(d, routes) {
			rep.StaleDocs = append(rep.StaleDocs, d)
		}
	}
	return rep
}

func main() {
	root := "."
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		root = os.Args[1]
	}
	jsonOut := false
	for _, a := range os.Args[1:] {
		if a == "--json" {
			jsonOut = true
		}
	}

	read := func(p string) string {
		b, err := os.ReadFile(filepath.Join(root, p))
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: cannot read %s: %v\n", p, err)
			return ""
		}
		return string(b)
	}
	serverFiles, _ := filepath.Glob(filepath.Join(root, "internal", "proxy", "*.go"))
	serverSrcs := []string{}
	for _, f := range serverFiles {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		if b, err := os.ReadFile(f); err == nil {
			serverSrcs = append(serverSrcs, string(b))
		}
	}
	rep := buildReport(serverSrcs,
		read(filepath.Join("internal", "proxy", "admin_openapi.go")),
		read(filepath.Join("cmd", "vibe", "main.go")),
		read(filepath.Join("sdk", "typescript", "vibe.ts")))

	appUISrcs := []string{}
	appUIRoot := filepath.Join(root, "web", "src")
	err := filepath.WalkDir(appUIRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if ext := filepath.Ext(path); ext != ".ts" && ext != ".tsx" {
			return nil
		}
		// web/src/shared/api/generated holds the OpenAPI-generated types, which name every
		// documented path whether or not a screen calls it. Counting those as bindings made
		// the audit compare the legacy console against the catalog instead of against the
		// React console, and it passed while whole screens were still missing from /app.
		if strings.Contains(filepath.ToSlash(path), "/shared/api/generated/") {
			return nil
		}
		if b, err := os.ReadFile(path); err == nil {
			appUISrcs = append(appUISrcs, string(b))
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot walk %s: %v\n", appUIRoot, err)
	}
	rep.LegacyConsolePaths, rep.AppConsolePaths, rep.ConsoleParityGaps = consoleParity(
		read(filepath.Join("internal", "proxy", "admin_ui.go")), appUISrcs)

	if jsonOut {
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(b))
	} else {
		fmt.Printf("API Surface Audit\n")
		fmt.Printf("  server routes : %d\n", len(rep.ServerRoutes))
		fmt.Printf("  OpenAPI paths : %d\n", len(rep.OpenAPIPaths))
		fmt.Printf("  CLI paths     : %d\n", len(rep.CLIPaths))
		fmt.Printf("  SDK paths     : %d\n", len(rep.SDKPaths))
		fmt.Printf("  legacy console: %d admin endpoints\n", len(rep.LegacyConsolePaths))
		fmt.Printf("  React console : %d admin endpoints\n", len(rep.AppConsolePaths))
		fmt.Printf("  cli_only (FAIL)         : %v\n", rep.CLIOnly)
		fmt.Printf("  sdk_only (FAIL)         : %v\n", rep.SDKOnly)
		fmt.Printf("  openapi_missing (FAIL)  : %v\n", rep.OpenAPIMissing)
		fmt.Printf("  undocumented_routes(FAIL): %v\n", rep.StaleDocs)
		fmt.Printf("  console_parity_gaps(FAIL): %v\n", rep.ConsoleParityGaps)
	}

	// A console audit that read nothing would pass by accident, which is worse than no check.
	if len(rep.LegacyConsolePaths) == 0 || len(rep.AppConsolePaths) == 0 {
		fmt.Fprintf(os.Stderr, "FAIL: console sources unreadable — legacy=%d app=%d endpoints found; run from the repo root\n",
			len(rep.LegacyConsolePaths), len(rep.AppConsolePaths))
		os.Exit(1)
	}

	// Fail on any contract gap: a client (CLI/SDK) path the server doesn't serve, a server route
	// absent from the OpenAPI catalog, a documented route that no longer exists, or a legacy
	// console endpoint the React console dropped. The repo is at zero gaps, so this keeps the
	// README/CLI/SDK/OpenAPI/server surfaces and the two consoles in lockstep.
	gaps := len(rep.CLIOnly) + len(rep.SDKOnly) + len(rep.OpenAPIMissing) + len(rep.StaleDocs) + len(rep.ConsoleParityGaps)
	if gaps > 0 {
		fmt.Fprintf(os.Stderr, "FAIL: %d API surface gap(s) — cli_only=%v sdk_only=%v openapi_missing=%v undocumented=%v console_parity=%v\n",
			gaps, rep.CLIOnly, rep.SDKOnly, rep.OpenAPIMissing, rep.StaleDocs, rep.ConsoleParityGaps)
		os.Exit(1)
	}
}
