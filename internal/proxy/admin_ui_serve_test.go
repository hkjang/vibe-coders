package proxy

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func adminUITestServer(t *testing.T) *httptest.Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://unused.invalid", "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return proxy
}

// The console is ~1.2 MB and was shipped uncompressed on every load. Compression is the
// difference between the admin feeling instant and feeling broken over a VPN, so assert
// both that it happens and that the bytes still decode to the real page.
func TestAdminUIIsCompressedAndCacheable(t *testing.T) {
	proxy := adminUITestServer(t)

	get := func(acceptEncoding, ifNoneMatch string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, proxy.URL+"/admin", nil)
		if err != nil {
			t.Fatal(err)
		}
		if acceptEncoding != "" {
			req.Header.Set("Accept-Encoding", acceptEncoding)
		}
		if ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		// The default transport adds gzip and decodes transparently, which would hide
		// exactly what this test is about.
		resp, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	plain := get("", "")
	defer plain.Body.Close()
	identity, err := io.ReadAll(plain.Body)
	if err != nil {
		t.Fatal(err)
	}
	if plain.Header.Get("Content-Encoding") != "" {
		t.Fatalf("a client that did not ask for gzip received %q", plain.Header.Get("Content-Encoding"))
	}
	if !strings.Contains(string(identity), "<!doctype html>") {
		t.Fatal("identity response is not the admin page")
	}
	etag := plain.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag, so every reload re-downloads the whole console")
	}
	if cc := plain.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control=%q, want no-cache — an upgraded gateway must not serve a stale console", cc)
	}
	if v := plain.Header.Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Fatalf("Vary=%q must include Accept-Encoding, or a shared cache will mix encodings", v)
	}

	zipped := get("gzip, deflate, br", "")
	defer zipped.Body.Close()
	if zipped.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("gzip was offered but the response was sent uncompressed")
	}
	raw, err := io.ReadAll(zipped.Body)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("Content-Encoding said gzip but the body does not decode: %v", err)
	}
	decoded, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != string(identity) {
		t.Fatal("the compressed body does not decode to the same page as the identity body")
	}
	// The whole reason for doing this: the transfer has to be substantially smaller.
	if len(raw) >= len(identity)/2 {
		t.Fatalf("gzip saved almost nothing: %d bytes vs %d identity", len(raw), len(identity))
	}
	t.Logf("identity %d KB -> gzip %d KB", len(identity)/1024, len(raw)/1024)

	// A reload with the validator must transfer no body at all.
	cached := get("gzip", etag)
	defer cached.Body.Close()
	if cached.StatusCode != http.StatusNotModified {
		t.Fatalf("If-None-Match returned %d, want 304", cached.StatusCode)
	}
	body, _ := io.ReadAll(cached.Body)
	if len(body) != 0 {
		t.Fatalf("304 carried a %d byte body", len(body))
	}

	// A stale validator must serve the page again rather than a spurious 304.
	stale := get("gzip", `"deadbeef"`)
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusOK {
		t.Fatalf("a stale ETag returned %d, want 200", stale.StatusCode)
	}
}

func TestAcceptsGzipParsing(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"deflate, gzip", true},
		{" GZIP ", true},
		{"gzip;q=0.5", true},
		{"deflate", false},
		{"br", false},
		// Must not be fooled by a substring of another token.
		{"x-gzip-something", false},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/admin", nil)
		if tc.header != "" {
			req.Header.Set("Accept-Encoding", tc.header)
		}
		if got := acceptsGzip(req); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}
}

func TestETagMatching(t *testing.T) {
	const etag = `"abc123"`
	cases := []struct {
		header string
		want   bool
	}{
		{`"abc123"`, true},
		{`W/"abc123"`, true}, // a weak validator still identifies the same bytes
		{`"other", "abc123"`, true},
		{`*`, true},
		{`"other"`, false},
		{``, false},
		{`"abc12"`, false}, // prefix must not match
	}
	for _, tc := range cases {
		if got := etagMatches(tc.header, etag); got != tc.want {
			t.Errorf("etagMatches(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}
}

// The page depends only on AppVersion, so rendering it per request wasted a 1.2 MB
// allocation each time. It must be prepared once and reused.
func TestAdminUIPageIsPreparedOnce(t *testing.T) {
	first := adminUIPage()
	second := adminUIPage()
	if &first.body[0] != &second.body[0] {
		t.Error("the admin page is re-rendered per call instead of being prepared once")
	}
	if strings.Contains(string(first.body), "__APP_VERSION__") {
		t.Error("the version placeholder was not substituted")
	}
	if !strings.Contains(string(first.body), AppVersion) {
		t.Errorf("the rendered page does not carry the build version %s", AppVersion)
	}
}
