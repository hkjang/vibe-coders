package proxy

import (
	"net/http/httptest"
	"testing"
)

func TestRequestOrigin(t *testing.T) {
	r := httptest.NewRequest("GET", "http://gw.local/me/onboarding-pack", nil)
	r.Host = "gw.local"
	if got := requestOrigin(r); got != "http://gw.local" {
		t.Fatalf("plain origin = %q", got)
	}
	// Forwarded headers (behind a proxy/LB) take precedence.
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Host", "gateway.example.com")
	if got := requestOrigin(r); got != "https://gateway.example.com" {
		t.Fatalf("forwarded origin = %q", got)
	}
}
