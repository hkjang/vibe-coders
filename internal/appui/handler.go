package appui

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	appPrefix       = "/app"
	appCacheControl = "no-cache"
	assetCacheLong  = "public, max-age=31536000, immutable"
)

var hashedAssetName = regexp.MustCompile(`[-.][A-Za-z0-9_-]{8,}\.[^.]+$`)

// Options controls request-time application UI behavior.
type Options struct {
	// Enabled is evaluated for every request so runtime settings can disable the
	// new console without restarting the server. A nil function means enabled.
	Enabled func(context.Context) bool
}

// NewHandler returns a handler for /app and /app/* using files from files.
// Supplying nil or a filesystem without index.html is supported and produces
// an operational fallback page rather than affecting other server routes.
func NewHandler(files fs.FS, options Options) http.Handler {
	return &handler{files: files, enabled: options.Enabled}
}

type handler struct {
	files           fs.FS
	enabled         func(context.Context) bool
	compressedFiles sync.Map
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != appPrefix && !strings.HasPrefix(r.URL.Path, appPrefix+"/") {
		notFound(w)
		return
	}

	setAppSecurityHeaders(w.Header())
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	if r.URL.Path == appPrefix {
		w.Header().Set("Cache-Control", appCacheControl)
		// ROUTE-003 does not require query preservation. Dropping it prevents an
		// accidental credential in /app?... from being reflected into Location and
		// persisted a second time by browser or intermediary redirect logs.
		w.Header().Set("Location", appPrefix+"/")
		w.WriteHeader(http.StatusPermanentRedirect)
		return
	}

	requested, trailingSlash, ok := appFilePath(r.URL)
	if !ok {
		notFound(w)
		return
	}

	if h.enabled != nil && !h.enabled(r.Context()) {
		if isAssetRequest(requested) {
			notFound(w)
			return
		}
		serveFallback(w, r, http.StatusOK, disabledPage)
		return
	}

	if requested != "" && !trailingSlash {
		data, info, err := h.readFile(requested)
		switch {
		case err == nil:
			h.serveFile(w, r, requested, data, info.ModTime())
			return
		case !errors.Is(err, fs.ErrNotExist):
			internalError(w)
			return
		}
	}

	if isAssetRequest(requested) {
		notFound(w)
		return
	}

	data, info, err := h.readFile("index.html")
	if err != nil {
		serveFallback(w, r, http.StatusServiceUnavailable, unavailablePage)
		return
	}
	h.serveFile(w, r, "index.html", data, info.ModTime())
}

func (h *handler) readFile(name string) ([]byte, fs.FileInfo, error) {
	if h.files == nil {
		return nil, nil, fs.ErrNotExist
	}
	info, err := fs.Stat(h.files, name)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fs.ErrNotExist
	}
	data, err := fs.ReadFile(h.files, name)
	if err != nil {
		return nil, nil, err
	}
	return data, info, nil
}

// appFilePath converts a URL below /app/ into an fs.ValidPath. Encoded path
// separators, backslashes, dot segments, empty segments, and hidden build
// placeholders are rejected before the filesystem is consulted.
func appFilePath(requestURL *url.URL) (name string, trailingSlash bool, ok bool) {
	escaped := requestURL.EscapedPath()
	if !strings.HasPrefix(escaped, appPrefix+"/") {
		return "", false, false
	}
	escaped = strings.TrimPrefix(escaped, appPrefix+"/")
	lowerEscaped := strings.ToLower(escaped)
	if strings.Contains(lowerEscaped, "%2f") || strings.Contains(lowerEscaped, "%5c") || strings.Contains(lowerEscaped, "%00") {
		return "", false, false
	}

	decoded, err := url.PathUnescape(escaped)
	if err != nil || strings.ContainsRune(decoded, '\x00') || strings.Contains(decoded, "\\") {
		return "", false, false
	}
	for _, r := range decoded {
		if r < 0x20 || r == 0x7f {
			return "", false, false
		}
	}

	if decoded == "" {
		return "", false, true
	}
	trailingSlash = strings.HasSuffix(decoded, "/")
	decoded = strings.TrimSuffix(decoded, "/")
	if decoded == "" || !fs.ValidPath(decoded) {
		return "", false, false
	}
	for _, segment := range strings.Split(decoded, "/") {
		if strings.HasPrefix(segment, ".") {
			return "", false, false
		}
	}
	return decoded, trailingSlash, true
}

func isAssetRequest(name string) bool {
	if name == "assets" || strings.HasPrefix(name, "assets/") {
		return true
	}
	// Public assets can live in nested directories. Only known static extensions are
	// classified as files, because client route parameters may legitimately contain
	// dots (for example /app/settings/ui.app.enabled).
	switch strings.ToLower(path.Ext(name)) {
	case ".avif", ".cjs", ".css", ".eot", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".map", ".mjs", ".otf", ".pdf", ".png", ".svg", ".ttf", ".txt", ".wasm", ".webmanifest", ".webp", ".woff", ".woff2", ".xml":
		return true
	default:
		return false
	}
}

func (h *handler) serveFile(w http.ResponseWriter, r *http.Request, name string, data []byte, modified time.Time) {
	if name == "index.html" {
		w.Header().Set("Cache-Control", appCacheControl)
	} else if strings.HasPrefix(name, "assets/") && hashedAssetName.MatchString(path.Base(name)) {
		w.Header().Set("Cache-Control", assetCacheLong)
	} else {
		w.Header().Set("Cache-Control", appCacheControl)
	}

	if contentType := mime.TypeByExtension(strings.ToLower(path.Ext(name))); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}

	representation := data
	if compressibleAsset(name) {
		w.Header().Add("Vary", "Accept-Encoding")
		if acceptsGzip(r.Header.Get("Accept-Encoding")) {
			compressed := h.gzipFile(name, data)
			if len(compressed) < len(data) {
				w.Header().Set("Content-Encoding", "gzip")
				representation = compressed
			}
		}
	}
	http.ServeContent(w, r, name, modified, bytes.NewReader(representation))
}

func compressibleAsset(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest":
		return true
	default:
		return false
	}
}

func acceptsGzip(header string) bool {
	for _, value := range strings.Split(header, ",") {
		parts := strings.Split(value, ";")
		if !strings.EqualFold(strings.TrimSpace(parts[0]), "gzip") {
			continue
		}
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, raw, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			if err != nil {
				return false
			}
			quality = parsed
		}
		return quality > 0
	}
	return false
}

func (h *handler) gzipFile(name string, data []byte) []byte {
	if cached, ok := h.compressedFiles.Load(name); ok {
		return cached.([]byte)
	}
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	if err != nil {
		return data
	}
	if _, err := writer.Write(data); err != nil {
		return data
	}
	if err := writer.Close(); err != nil {
		return data
	}
	compressed := buffer.Bytes()
	actual, _ := h.compressedFiles.LoadOrStore(name, compressed)
	return actual.([]byte)
}

func serveFallback(w http.ResponseWriter, r *http.Request, status int, page []byte) {
	w.Header().Set("Cache-Control", appCacheControl)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(page)))
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "60")
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func notFound(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, http.StatusText(http.StatusNotFound), http.StatusNotFound)
}

func internalError(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
}
