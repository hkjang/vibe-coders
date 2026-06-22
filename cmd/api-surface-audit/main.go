// Command api-surface-audit statically compares the API surface that clients (the cmd/vibe CLI
// and the TypeScript SDK) and the OpenAPI catalog expect against the routes the server actually
// registers. It exists so a server route rename can't silently break the published client
// contract: run `go run ./cmd/api-surface-audit` (CI fails on a contract break).
//
// It is deliberately a static analyzer (no server boot): it greps mux.HandleFunc registrations,
// the apiEndpoints OpenAPI catalog, and the path literals in the CLI/SDK sources.
package main

import (
	"encoding/json"
	"fmt"
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
}

var (
	reHandleFunc = regexp.MustCompile(`mux\.HandleFunc\(\s*"([^"]+)"`)
	reOpenAPI    = regexp.MustCompile(`\{"(/[^"]*)",\s*\[\]string\{`)
	reClientGo   = regexp.MustCompile(`"(/(?:v1|me|mcp)[^"]*)"`)
	reClientTS   = regexp.MustCompile("[\"`](/(?:v1|me|mcp)[^\"`]*)[\"`]")
)

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

	if jsonOut {
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(b))
	} else {
		fmt.Printf("API Surface Audit\n")
		fmt.Printf("  server routes : %d\n", len(rep.ServerRoutes))
		fmt.Printf("  OpenAPI paths : %d\n", len(rep.OpenAPIPaths))
		fmt.Printf("  CLI paths     : %d\n", len(rep.CLIPaths))
		fmt.Printf("  SDK paths     : %d\n", len(rep.SDKPaths))
		fmt.Printf("  cli_only (FAIL)        : %v\n", rep.CLIOnly)
		fmt.Printf("  sdk_only (FAIL)        : %v\n", rep.SDKOnly)
		fmt.Printf("  openapi_missing (warn) : %d routes not in OpenAPI catalog\n", len(rep.OpenAPIMissing))
		fmt.Printf("  undocumented_routes(warn): %d OpenAPI entries with no server route\n", len(rep.StaleDocs))
	}

	// Fail only on contract breaks: a client (CLI/SDK) path the server does not serve.
	if len(rep.CLIOnly) > 0 || len(rep.SDKOnly) > 0 {
		fmt.Fprintf(os.Stderr, "FAIL: client paths without a server route — cli_only=%v sdk_only=%v\n", rep.CLIOnly, rep.SDKOnly)
		os.Exit(1)
	}
}
