package proxy

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

const externalIPUnknown = "unknown"

type effectiveClientIPContextKey struct{}
type trustedForwardedForContextKey struct{}

func parseTrustedProxyCIDRs(values []string) ([]netip.Prefix, error) {
	prefixes := make([]netip.Prefix, 0, len(values))
	seen := make(map[netip.Prefix]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		prefix, err := netip.ParsePrefix(value)
		if err != nil || prefix.Addr().Zone() != "" {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q", value)
		}
		prefix = prefix.Masked()
		if _, exists := seen[prefix]; exists {
			continue
		}
		seen[prefix] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

// withTrustedClientIP resolves forwarding headers only when the directly connected
// peer belongs to an explicitly configured proxy network. Direct clients cannot use
// those headers to bypass IP allowlists or split quota buckets.
func withTrustedClientIP(next http.Handler, trusted []netip.Prefix) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		direct := directClientIPAddress(r.RemoteAddr)
		effective := direct
		forwardedFor := ""
		if direct != externalIPUnknown && trustedProxyAddress(direct, trusted) {
			effective, forwardedFor = trustedForwardedClientIPAddress(r, direct, trusted)
		}
		ctx := context.WithValue(r.Context(), effectiveClientIPContextKey{}, effective)
		ctx = context.WithValue(ctx, trustedForwardedForContextKey{}, forwardedFor)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func directClientIPAddress(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		if address, ok := canonicalExternalIPAddress(host); ok {
			return address
		}
	} else if address, ok := canonicalExternalIPAddress(remoteAddr); ok {
		return address
	}
	return externalIPUnknown
}

func trustedProxyAddress(address string, trusted []netip.Prefix) bool {
	parsed, err := netip.ParseAddr(address)
	if err != nil {
		return false
	}
	parsed = parsed.Unmap()
	for _, prefix := range trusted {
		if prefix.Contains(parsed) {
			return true
		}
	}
	return false
}

func trustedForwardedClientIPAddress(r *http.Request, direct string, trusted []netip.Prefix) (string, string) {
	raw := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if raw == "" || len(raw) > 4<<10 {
		return direct, ""
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 32 {
		return direct, ""
	}
	forwardedChain := make([]string, 0, len(parts))
	for _, part := range parts {
		address, ok := canonicalExternalIPAddress(part)
		if !ok || address == externalIPUnknown {
			return direct, ""
		}
		forwardedChain = append(forwardedChain, address)
	}
	chain := append(append([]string(nil), forwardedChain...), direct)
	trustedChain := strings.Join(forwardedChain, ", ")
	for index := len(chain) - 1; index >= 0; index-- {
		if !trustedProxyAddress(chain[index], trusted) {
			return chain[index], trustedChain
		}
	}
	return chain[0], trustedChain
}

func trustedForwardedFor(r *http.Request) string {
	if value, ok := r.Context().Value(trustedForwardedForContextKey{}).(string); ok {
		return value
	}
	return ""
}

func canonicalExternalIPAddress(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, externalIPUnknown) {
		return externalIPUnknown, true
	}
	if len(value) > 128 {
		return "", false
	}
	address, err := netip.ParseAddr(value)
	if err != nil || address.Zone() != "" {
		return "", false
	}
	return address.Unmap().String(), true
}

func boundedExternalIPAddress(value string) string {
	if address, ok := validatedExternalIPAddress(value); ok {
		return address
	}
	return externalIPUnknown
}

// validatedExternalIPAddress preserves an already-stored valid representation so
// legacy aggregate links still address the exact database group. New ingress is
// canonicalized by clientIP, while malformed legacy values are never returned.
func validatedExternalIPAddress(value string) (string, bool) {
	value = strings.TrimSpace(value)
	canonical, ok := canonicalExternalIPAddress(value)
	if !ok {
		return "", false
	}
	if canonical == externalIPUnknown {
		return externalIPUnknown, true
	}
	return value, true
}

func boundedExternalForwardedFor(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) > 4<<10 {
		return externalIPUnknown
	}
	addresses := make([]string, 0, 4)
	for _, raw := range strings.Split(value, ",") {
		if len(addresses) == 32 {
			break
		}
		address, ok := canonicalExternalIPAddress(raw)
		if !ok || address == externalIPUnknown {
			continue
		}
		addresses = append(addresses, address)
	}
	if len(addresses) == 0 {
		return externalIPUnknown
	}
	return strings.Join(addresses, ", ")
}
