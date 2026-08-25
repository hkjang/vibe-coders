package proxy

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
)

// Serving the admin UI.
//
// The whole console is one ~1.2 MB HTML document. It used to be sent uncompressed on
// every load, with no validator, and the version placeholder was substituted afresh
// each time — so each request allocated a new 1.2 MB string and put all of it on the
// wire. On a VPN or an air-gapped site that is the difference between the admin feeling
// instant and feeling broken.
//
// The document depends on nothing but AppVersion, so it is rendered, compressed and
// fingerprinted exactly once and then served from memory:
//
//	gzip      1219 KB → ~280 KB for any client that accepts it (all browsers do)
//	ETag      a repeat load becomes a 304 with an empty body
//	no-cache  the validator is still revalidated every time, so an upgraded gateway
//	          never serves a stale console out of the browser cache
type renderedPage struct {
	body     []byte
	gzipped  []byte
	etag     string
	mimeType string
}

var (
	adminPageOnce sync.Once
	adminPage     renderedPage
)

// renderPage prepares a static document for serving: the substituted body, a gzip copy,
// and an ETag over the identity bytes.
func renderPage(html, mimeType string) renderedPage {
	body := []byte(strings.ReplaceAll(html, "__APP_VERSION__", AppVersion))
	sum := sha256.Sum256(body)
	page := renderedPage{body: body, etag: `"` + hex.EncodeToString(sum[:16]) + `"`, mimeType: mimeType}

	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err == nil {
		if _, err = zw.Write(body); err == nil && zw.Close() == nil {
			page.gzipped = buf.Bytes()
		}
	}
	// A failed compression is not fatal: serving the identity bytes is still correct,
	// just larger.
	return page
}

func adminUIPage() renderedPage {
	adminPageOnce.Do(func() { adminPage = renderPage(adminHTML, "text/html; charset=utf-8") })
	return adminPage
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		// Ignore any q-value; "gzip;q=0" is vanishingly rare and serving identity to it
		// is merely suboptimal, never wrong.
		if strings.EqualFold(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]), "gzip") {
			return true
		}
	}
	return false
}

// servePage writes a prepared page, honouring conditional requests and gzip.
func servePage(w http.ResponseWriter, r *http.Request, page renderedPage) {
	h := w.Header()
	h.Set("Content-Type", page.mimeType)
	h.Set("ETag", page.etag)
	// Revalidate every time rather than caching by age: an operator who upgrades the
	// gateway must not be handed the previous console from their browser cache.
	h.Set("Cache-Control", "no-cache")
	// The body varies with Accept-Encoding, so any shared cache must key on it.
	h.Add("Vary", "Accept-Encoding")

	if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, page.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if len(page.gzipped) > 0 && acceptsGzip(r) {
		h.Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(page.gzipped)
		}
		return
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(page.body)
	}
}

// etagMatches implements the If-None-Match comparison: a list of candidates, "*" as a
// wildcard, and weak validators comparing equal to their strong form.
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" {
			return true
		}
		if strings.TrimPrefix(candidate, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}
