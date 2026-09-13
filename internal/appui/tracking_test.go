package appui

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"vibe-coders/internal/tracking"
)

const trackedIndex = "<!doctype html><html><head><title>app</title></head><body><p>INDEX</p></body></html>"

func trackedFiles() fstest.MapFS {
	files := testFiles()
	files["index.html"] = &fstest.MapFile{Data: []byte(trackedIndex), ModTime: time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC)}
	return files
}

func trackingHandler(config tracking.Config) http.Handler {
	return NewHandler(trackedFiles(), Options{Tracking: func(context.Context) tracking.Config { return config }})
}

var nonceAttribute = regexp.MustCompile(`nonce="([A-Za-z0-9_-]+)"`)

func TestTrackingOffServesTheUntouchedPage(t *testing.T) {
	for name, handler := range map[string]http.Handler{
		"no tracking option": NewHandler(trackedFiles(), Options{}),
		"disabled":           trackingHandler(tracking.Config{Provider: tracking.ProviderMomento, MomentoURL: "https://m.example", MomentoSiteID: "s"}),
		"provider none":      trackingHandler(tracking.Config{Enabled: true}),
		"incomplete":         trackingHandler(tracking.Config{Enabled: true, Provider: tracking.ProviderMomento}),
	} {
		t.Run(name, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, "/app/overview")
			if response.Code != http.StatusOK || response.Body.String() != trackedIndex {
				t.Fatalf("page changed: %d %q", response.Code, response.Body.String())
			}
			if csp := response.Header().Get("Content-Security-Policy"); csp != appContentSecurityPolicy {
				t.Fatalf("policy changed while tracking is off: %q", csp)
			}
			if response.Header().Get("Cache-Control") != appCacheControl || response.Header().Get("Last-Modified") == "" {
				t.Fatalf("caching headers changed while tracking is off: %v", response.Header())
			}
		})
	}
}

func TestTrackingOnInjectsNoncedSnippetAndWidensPolicyOnlyForThePage(t *testing.T) {
	config := tracking.Config{Enabled: true, Provider: tracking.ProviderMomento, MomentoURL: "https://momento.corp.example", MomentoSiteID: "vibe", Placement: tracking.PlacementHead}
	handler := trackingHandler(config)

	first := performRequest(t, handler, http.MethodGet, "/app/overview")
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d", first.Code)
	}
	body := first.Body.String()
	matches := nonceAttribute.FindStringSubmatch(body)
	if matches == nil {
		t.Fatalf("no nonce in page: %s", body)
	}
	nonce := matches[1]
	if !strings.Contains(body, `<script nonce="`+nonce+`" async src="https://momento.corp.example/tracker.js"`) || !strings.Contains(body, "</script>\n</head>") {
		t.Fatalf("snippet not placed in head with the nonce: %s", body)
	}
	csp := first.Header().Get("Content-Security-Policy")
	for _, want := range []string{"script-src 'self' 'nonce-" + nonce + "' https://momento.corp.example", "connect-src 'self' https://momento.corp.example", "report-uri " + tracking.ReportPath} {
		if !strings.Contains(csp, want) {
			t.Fatalf("policy missing %q: %q", want, csp)
		}
	}
	if strings.Contains(csp, "unsafe-inline") && !strings.Contains(appContentSecurityPolicy, "unsafe-inline") {
		t.Fatalf("policy gained unsafe-inline: %q", csp)
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Fatalf("script-src must not use unsafe-inline: %q", csp)
	}
	if first.Header().Get("Cache-Control") != "no-store" || first.Header().Get("Last-Modified") != "" || first.Header().Get("ETag") != "" {
		t.Fatalf("a nonced page must not be revalidatable: %v", first.Header())
	}

	second := performRequest(t, handler, http.MethodGet, "/app/overview")
	if again := nonceAttribute.FindStringSubmatch(second.Body.String()); again == nil || again[1] == nonce {
		t.Fatalf("nonce must differ per request: %v vs %s", again, nonce)
	}

	// Assets and non-page paths keep the strict policy.
	asset := performRequest(t, handler, http.MethodGet, "/app/assets/app.js")
	if csp := asset.Header().Get("Content-Security-Policy"); csp != appContentSecurityPolicy {
		t.Fatalf("asset policy widened: %q", csp)
	}

	head := performRequest(t, handler, http.MethodHead, "/app/overview")
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD = %d body %d", head.Code, head.Body.Len())
	}
}

func TestTrackingBodyPlacementAndProxyMode(t *testing.T) {
	config := tracking.Config{Enabled: true, Provider: tracking.ProviderMomento, MomentoURL: "https://momento.corp.example", MomentoSiteID: "vibe", MomentoProxy: true, Placement: tracking.PlacementBody}
	response := performRequest(t, trackingHandler(config), http.MethodGet, "/app/")
	body := response.Body.String()
	if !strings.Contains(body, `data-endpoint="/momento"></script>`+"\n</body>") {
		t.Fatalf("body placement with proxy: %s", body)
	}
	csp := response.Header().Get("Content-Security-Policy")
	if strings.Contains(csp, "momento.corp.example") || !strings.Contains(csp, "'nonce-") {
		t.Fatalf("proxied momento must keep the policy same-origin: %q", csp)
	}
}
