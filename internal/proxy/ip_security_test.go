package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCanonicalExternalIPAddress(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		want  string
		ok    bool
	}{
		{name: "IPv4", value: "192.0.2.10", want: "192.0.2.10", ok: true},
		{name: "IPv6", value: "2001:db8::1", want: "2001:db8::1", ok: true},
		{name: "mapped IPv4", value: "::ffff:192.0.2.10", want: "192.0.2.10", ok: true},
		{name: "unknown", value: "unknown", want: externalIPUnknown, ok: true},
		{name: "empty", value: "", want: externalIPUnknown, ok: true},
		{name: "email", value: "victim@example.com"},
		{name: "token", value: "ghp_" + strings.Repeat("A", 36)},
		{name: "host port", value: "192.0.2.10:443"},
		{name: "zone", value: "fe80::1%private-zone"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := canonicalExternalIPAddress(test.value)
			if got != test.want || ok != test.ok {
				t.Fatalf("canonicalExternalIPAddress(%q) = (%q, %v), want (%q, %v)", test.value, got, ok, test.want, test.ok)
			}
		})
	}
	if got := boundedExternalForwardedFor("192.0.2.10, victim@example.com, 2001:db8::2"); got != "192.0.2.10, 2001:db8::2" {
		t.Fatalf("bounded forwarded-for = %q", got)
	}
	if got := boundedExternalForwardedFor("victim@example.com"); got != externalIPUnknown {
		t.Fatalf("invalid forwarded-for = %q, want %q", got, externalIPUnknown)
	}
}

func TestClientIPIgnoresForwardingHeadersFromUntrustedPeer(t *testing.T) {
	request := httptest.NewRequest("GET", "http://gateway.invalid", nil)
	request.RemoteAddr = "192.0.2.99:12345"
	request.Header.Set("X-Real-IP", "2001:db8::7")
	request.Header.Set("X-Forwarded-For", "203.0.113.4")
	called := false
	withTrustedClientIP(http.HandlerFunc(func(_ http.ResponseWriter, gotRequest *http.Request) {
		called = true
		if got := clientIP(gotRequest); got != "192.0.2.99" {
			t.Fatalf("clientIP = %q, want directly connected peer", got)
		}
		if got := trustedForwardedFor(gotRequest); got != "" {
			t.Fatalf("untrusted forwarded-for was retained for audit: %q", got)
		}
	}), nil).ServeHTTP(httptest.NewRecorder(), request)
	if !called {
		t.Fatal("wrapped handler was not called")
	}
}

func TestClientIPUsesValidatedHeadersFromTrustedProxy(t *testing.T) {
	trusted, err := parseTrustedProxyCIDRs([]string{"192.0.2.0/24", "10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	assertClientIP := func(name string, headers map[string]string, want, wantForwarded string) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "http://gateway.invalid", nil)
			request.RemoteAddr = "192.0.2.99:12345"
			for key, value := range headers {
				request.Header.Set(key, value)
			}
			withTrustedClientIP(http.HandlerFunc(func(_ http.ResponseWriter, gotRequest *http.Request) {
				if got := clientIP(gotRequest); got != want {
					t.Fatalf("clientIP = %q, want %q", got, want)
				}
				if got := trustedForwardedFor(gotRequest); got != wantForwarded {
					t.Fatalf("trusted forwarded-for = %q, want %q", got, wantForwarded)
				}
			}), trusted).ServeHTTP(httptest.NewRecorder(), request)
		})
	}
	assertClientIP("single-value spoofing headers are ignored", map[string]string{
		"CF-Connecting-IP": "203.0.113.8",
		"X-Real-IP":        "2001:db8::7",
	}, "192.0.2.99", "")
	assertClientIP("forwarded chain", map[string]string{
		"CF-Connecting-IP": "203.0.113.8",
		"X-Forwarded-For":  "198.51.100.8, 10.1.2.3",
	}, "198.51.100.8", "198.51.100.8, 10.1.2.3")
	assertClientIP("malformed chain", map[string]string{
		"X-Forwarded-For": "ghp_" + strings.Repeat("A", 36) + ", 198.51.100.8",
	}, "192.0.2.99", "")
}

func TestParseTrustedProxyCIDRsRejectsInvalidValues(t *testing.T) {
	if _, err := parseTrustedProxyCIDRs([]string{"not-a-network"}); err == nil {
		t.Fatal("expected invalid trusted proxy CIDR to fail")
	}
}
