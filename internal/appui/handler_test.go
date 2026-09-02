package appui

import (
	"compress/gzip"
	"context"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const testIndex = "<!doctype html><title>app index</title><p>INDEX</p>"

func testFiles() fstest.MapFS {
	modified := time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC)
	return fstest.MapFS{
		"index.html":                      {Data: []byte(testIndex), ModTime: modified},
		"providers":                       {Data: []byte("ACTUAL PROVIDERS FILE"), ModTime: modified},
		"config.json":                     {Data: []byte(`{"version":"test"}`), ModTime: modified},
		"assets/index-Baw36Abc.js":        {Data: []byte("console.log('hashed')"), ModTime: modified},
		"assets/bundle-abcdefgh.js":       {Data: []byte(strings.Repeat("const value = 'compressible';\n", 400)), ModTime: modified},
		"assets/app.js":                   {Data: []byte("console.log('plain')"), ModTime: modified},
		"assets/application.js":           {Data: []byte("console.log('long but unhashed')"), ModTime: modified},
		"assets/theme-a1b2c3d4.css":       {Data: []byte("body { color: black; }"), ModTime: modified},
		"assets/nested/icon-a1b2c3d4.svg": {Data: []byte("<svg></svg>"), ModTime: modified},
	}
}

func performRequest(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestAppRedirectDropsQuery(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})

	for _, tt := range []struct {
		name, method, target string
	}{
		{name: "ordinary GET", method: http.MethodGet, target: "/app?return_to=%2Fapp%2Fproviders&x=1"},
		{name: "secret GET", method: http.MethodGet, target: "/app?q=Bearer%20redirect-secret-value"},
		{name: "ordinary HEAD", method: http.MethodHead, target: "/app?from=legacy"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			response := performRequest(t, handler, tt.method, tt.target)
			if response.Code != http.StatusPermanentRedirect {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusPermanentRedirect)
			}
			if location := response.Header().Get("Location"); location != "/app/" {
				t.Fatalf("Location = %q", location)
			}
			if reflected := response.Header().Get("Location") + response.Body.String(); strings.Contains(reflected, "redirect-secret-value") || strings.Contains(reflected, "return_to") {
				t.Fatalf("redirect reflected query data: %q", reflected)
			}
			if response.Header().Get("Cache-Control") != appCacheControl {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
			if response.Body.Len() != 0 {
				t.Fatalf("redirect body length = %d, want 0", response.Body.Len())
			}
		})
	}
}

func TestDeepLinksFallBackToIndex(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for _, target := range []string{
		"/app/",
		"/app/overview",
		"/app/routing/decisions/123",
		"/app/routing/decisions/123/",
		"/app/settings/ui.app.enabled",
	} {
		t.Run(target, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, target)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			if body := response.Body.String(); !strings.Contains(body, "INDEX") {
				t.Fatalf("body does not contain index marker: %q", body)
			}
			if response.Header().Get("Cache-Control") != appCacheControl {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestActualFilesTakePrecedenceOverSPAFallback(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for target, marker := range map[string]string{
		"/app/providers":   "ACTUAL PROVIDERS FILE",
		"/app/config.json": `"version":"test"`,
		"/app/index.html":  "INDEX",
	} {
		t.Run(target, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, target)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			if !strings.Contains(response.Body.String(), marker) {
				t.Fatalf("body = %q, want marker %q", response.Body.String(), marker)
			}
		})
	}

	response := performRequest(t, handler, http.MethodGet, "/app/config.json/")
	if response.Code != http.StatusNotFound {
		t.Fatalf("file with trailing slash status = %d, want 404", response.Code)
	}
}

func TestMissingAssetsAndExtensionPathsDoNotFallBack(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for _, target := range []string{
		"/app/assets",
		"/app/assets/missing.js",
		"/app/assets/missing-without-extension",
		"/app/missing.css",
		"/app/icons/missing.svg",
		"/app/fonts/missing.woff2",
		"/app/foo/bar.js",
		"/app/manifest.webmanifest",
	} {
		t.Run(target, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, target)
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body = %q", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "INDEX") {
				t.Fatal("missing asset returned SPA index")
			}
		})
	}
}

func TestUnsafePathsAreRejected(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for _, target := range []string{
		"/app/../admin",
		"/app/%2e%2e/admin",
		"/app/assets/%2e%2e/index.html",
		"/app/assets%2Findex-Baw36Abc.js",
		"/app/foo%5cbar",
		"/app//providers",
		"/app/.gitkeep",
		"/app/%00",
	} {
		t.Run(target, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, target)
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body = %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestCacheAndSecurityHeaders(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	tests := []struct {
		name         string
		target       string
		cacheControl string
		contentType  string
	}{
		{name: "index", target: "/app/", cacheControl: appCacheControl, contentType: "text/html"},
		{name: "hashed javascript", target: "/app/assets/index-Baw36Abc.js", cacheControl: assetCacheLong, contentType: "javascript"},
		{name: "hashed stylesheet", target: "/app/assets/theme-a1b2c3d4.css", cacheControl: assetCacheLong, contentType: "text/css"},
		{name: "nested hashed image", target: "/app/assets/nested/icon-a1b2c3d4.svg", cacheControl: assetCacheLong, contentType: "image/svg+xml"},
		{name: "unhashed asset", target: "/app/assets/app.js", cacheControl: appCacheControl, contentType: "javascript"},
		{name: "long unhashed asset", target: "/app/assets/application.js", cacheControl: appCacheControl, contentType: "javascript"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(t, handler, http.MethodGet, test.target)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			if got := response.Header().Get("Cache-Control"); got != test.cacheControl {
				t.Fatalf("Cache-Control = %q, want %q", got, test.cacheControl)
			}
			if got := response.Header().Get("Content-Type"); !strings.Contains(got, test.contentType) {
				t.Fatalf("Content-Type = %q, want substring %q", got, test.contentType)
			}
			csp := response.Header().Get("Content-Security-Policy")
			if csp == "" || strings.Contains(csp, "unsafe-eval") || !strings.Contains(csp, "script-src 'self';") {
				t.Fatalf("unexpected CSP = %q", csp)
			}
			if !strings.Contains(csp, "style-src-elem 'self' 'unsafe-inline'") || !strings.Contains(csp, "style-src-attr 'unsafe-inline'") {
				t.Fatalf("CSP does not allow the owned UI library's runtime styles: %q", csp)
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q", response.Header().Get("X-Content-Type-Options"))
			}
		})
	}
}

func TestCompressibleAssetsUseGzipNegotiation(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	request := httptest.NewRequest(http.MethodGet, "/app/assets/bundle-abcdefgh.js", nil)
	request.Header.Set("Accept-Encoding", "br, gzip")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", response.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(response.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary = %q", response.Header().Get("Vary"))
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !strings.Contains(string(decoded), "compressible") {
		t.Fatalf("decoded gzip body is invalid: err=%v", err)
	}

	identityRequest := httptest.NewRequest(http.MethodGet, "/app/assets/bundle-abcdefgh.js", nil)
	identityRequest.Header.Set("Accept-Encoding", "gzip;q=0")
	identity := httptest.NewRecorder()
	handler.ServeHTTP(identity, identityRequest)
	if identity.Header().Get("Content-Encoding") != "" {
		t.Fatalf("gzip;q=0 received Content-Encoding %q", identity.Header().Get("Content-Encoding"))
	}
}

func TestOnlyGetAndHeadAreAllowed(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		t.Run(method, func(t *testing.T) {
			response := performRequest(t, handler, method, "/app/providers")
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want 405", response.Code)
			}
			if allow := response.Header().Get("Allow"); allow != "GET, HEAD" {
				t.Fatalf("Allow = %q", allow)
			}
		})
	}
}

func TestHeadResponsesHaveNoBody(t *testing.T) {
	enabled := NewHandler(testFiles(), Options{})
	disabled := NewHandler(testFiles(), Options{Enabled: func(context.Context) bool { return false }})
	missing := NewHandler(fstest.MapFS{}, Options{})

	for name, handler := range map[string]http.Handler{
		"index":       enabled,
		"asset":       enabled,
		"disabled":    disabled,
		"unavailable": missing,
	} {
		t.Run(name, func(t *testing.T) {
			target := "/app/"
			if name == "asset" {
				target = "/app/assets/index-Baw36Abc.js"
			}
			response := performRequest(t, handler, http.MethodHead, target)
			if response.Code != http.StatusOK && response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d", response.Code)
			}
			if response.Body.Len() != 0 {
				t.Fatalf("HEAD body length = %d, want 0", response.Body.Len())
			}
		})
	}
}

func TestDisabledAppUsesFallbackAndDoesNotServeAssets(t *testing.T) {
	handler := NewHandler(testFiles(), Options{
		Enabled: func(context.Context) bool { return false },
	})

	for _, target := range []string{"/app/", "/app/overview"} {
		response := performRequest(t, handler, http.MethodGet, target)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", target, response.Code)
		}
		body := response.Body.String()
		if !strings.Contains(body, "비활성화") || !strings.Contains(body, `href="/admin"`) {
			t.Fatalf("%s fallback body = %q", target, body)
		}
	}

	for _, target := range []string{"/app/assets/index-Baw36Abc.js", "/app/favicon.ico"} {
		response := performRequest(t, handler, http.MethodGet, target)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, response.Code)
		}
	}
}

func TestMissingBuildUsesUnavailableFallback(t *testing.T) {
	for name, files := range map[string]fs.FS{
		"empty filesystem": fstest.MapFS{},
		"nil filesystem":   nil,
	} {
		t.Run(name, func(t *testing.T) {
			handler := NewHandler(files, Options{})
			for _, target := range []string{"/app/", "/app/providers"} {
				response := performRequest(t, handler, http.MethodGet, target)
				if response.Code != http.StatusServiceUnavailable {
					t.Fatalf("%s status = %d, want 503", target, response.Code)
				}
				body := response.Body.String()
				if !strings.Contains(body, "포함되지 않았습니다") || !strings.Contains(body, `href="/admin"`) {
					t.Fatalf("%s fallback body = %q", target, body)
				}
				if response.Header().Get("Retry-After") != "60" {
					t.Fatalf("Retry-After = %q", response.Header().Get("Retry-After"))
				}
			}

			asset := performRequest(t, handler, http.MethodGet, "/app/assets/missing.js")
			if asset.Code != http.StatusNotFound {
				t.Fatalf("missing asset status = %d, want 404", asset.Code)
			}
		})
	}
}

func TestEmbeddedFallbackAssetsAreAvailable(t *testing.T) {
	if EmbeddedFS() == nil {
		t.Fatal("EmbeddedFS returned nil")
	}
	if !strings.Contains(string(disabledPage), `href="/admin"`) {
		t.Fatal("disabled fallback does not link to /admin")
	}
	if !strings.Contains(string(unavailablePage), `href="/admin"`) {
		t.Fatal("unavailable fallback does not link to /admin")
	}
}

func TestHandlerDoesNotOwnOtherRoutes(t *testing.T) {
	handler := NewHandler(testFiles(), Options{})
	for _, target := range []string{"/", "/admin", "/auth/me", "/v1/chat/completions", "/mcp"} {
		response := performRequest(t, handler, http.MethodGet, target)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, response.Code)
		}
	}
}
