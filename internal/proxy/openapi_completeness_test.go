package proxy

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// OpenAPI completeness.
//
// The published spec behind /openapi.json and /swagger is a hand-maintained table, and
// routes are registered separately with mux.HandleFunc. Nothing connected the two, so an
// endpoint could be served for months without ever appearing in the spec — two were,
// and they were found by diffing the sources rather than by anything failing.
//
// This is the same shape as the retention list: a second list somebody has to remember
// to update. The fix is the same — make the build ask.
//
// Deliberately out of scope: prefix handlers (paths ending in "/") dispatch sub-resources
// whose spec entries use {id} templates, so they are matched by their documented parent
// rather than by literal string equality.
var adminRouteExemptions = map[string]string{
	// Sub-router prefixes and internal endpoints that are not part of the published API.
	"/admin":  "the console HTML itself, not a JSON API endpoint",
	"/admin/": "the console HTML itself, not a JSON API endpoint",
}

var (
	handleFuncRe = regexp.MustCompile(`mux\.HandleFunc\("([^"]+)"`)
	specPathRe   = regexp.MustCompile(`\{"(/[^"]+)",\s*\[\]string`)
)

func readProxyFile(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}

func TestEveryAdminRouteIsInTheOpenAPISpec(t *testing.T) {
	served := handleFuncRe.FindAllStringSubmatch(readProxyFile(t, "server.go"), -1)
	documented := map[string]bool{}
	for _, m := range specPathRe.FindAllStringSubmatch(readProxyFile(t, "admin_openapi.go"), -1) {
		documented[m[1]] = true
	}

	checked := 0
	for _, m := range served {
		path := m[1]
		if !strings.HasPrefix(path, "/admin") {
			continue
		}
		if _, exempt := adminRouteExemptions[path]; exempt {
			continue
		}
		// A prefix handler serves templated children; the spec documents those with
		// {id} placeholders, so require the prefix's parent to be documented instead.
		if strings.HasSuffix(path, "/") {
			parent := strings.TrimSuffix(path, "/")
			if !documented[parent] && !documentedAsTemplate(documented, parent) {
				t.Errorf("prefix route %q serves sub-resources but neither %q nor a {id} form of it is in the OpenAPI spec",
					path, parent)
			}
			continue
		}
		checked++
		if !documented[path] {
			t.Errorf("route %q is served but missing from the OpenAPI spec in admin_openapi.go.\n"+
				"Add an entry, or record it in adminRouteExemptions with the reason it is not public.", path)
		}
	}
	if checked < 100 {
		t.Fatalf("only %d admin routes were checked; the route extractor has stopped matching", checked)
	}
}

// documentedAsTemplate reports whether the spec documents a templated child of parent,
// e.g. "/admin/teams/{team}" covering the "/admin/teams/" prefix handler.
func documentedAsTemplate(documented map[string]bool, parent string) bool {
	for path := range documented {
		if strings.HasPrefix(path, parent+"/") && strings.Contains(path, "{") {
			return true
		}
	}
	return false
}

// The reverse drift: a spec entry for something no longer served is a documented
// endpoint that 404s, which is worse than an undocumented one.
func TestOpenAPISpecDoesNotDocumentRemovedRoutes(t *testing.T) {
	server := readProxyFile(t, "server.go")
	served := map[string]bool{}
	for _, m := range handleFuncRe.FindAllStringSubmatch(server, -1) {
		served[m[1]] = true
	}

	for _, m := range specPathRe.FindAllStringSubmatch(readProxyFile(t, "admin_openapi.go"), -1) {
		path := m[1]
		if !strings.HasPrefix(path, "/admin") || served[path] {
			continue
		}
		// Templated paths are served by their prefix handler.
		if strings.Contains(path, "{") {
			base := path[:strings.Index(path, "{")]
			if _, exempt := adminRouteExemptions[base]; !exempt && served[base] {
				continue
			}
			t.Errorf("spec documents %q but no handler serves the %q prefix", path, base)
			continue
		}
		// A plain path may still be served by a prefix handler one level up — but not by
		// "/admin/", which serves the console HTML rather than API sub-resources. Treating
		// it as a covering prefix would make this check pass for every path under /admin,
		// which is to say for everything it is meant to check.
		if idx := strings.LastIndex(path, "/"); idx > 0 {
			prefix := path[:idx+1]
			if _, exempt := adminRouteExemptions[prefix]; !exempt && served[prefix] {
				continue
			}
		}
		t.Errorf("spec documents %q but nothing serves it; a documented endpoint that 404s "+
			"is worse than an undocumented one", path)
	}
}
