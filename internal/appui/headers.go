package appui

import "net/http"

// Radix focus/scroll primitives and Sonner generate presentation-only style elements and
// attributes at runtime. CSP Level 3 permits those styles explicitly while scripts remain
// strictly external and same-origin: unsafe-inline and unsafe-eval are never allowed for script.
const appContentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"

func setAppSecurityHeaders(header http.Header) {
	header.Set("Content-Security-Policy", appContentSecurityPolicy)
	header.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
}
