package proxy

import (
	"context"
	"crypto/subtle"
	"strings"
)

const (
	providerRefPrefix = "prv_"
	// A full SHA-256 digest is 43 bytes in unpadded base64url form.
	providerRefLength = len(providerRefPrefix) + 43
)

type providerReferenceFunc func(string) string

type providerReferences struct {
	physical providerReferenceFunc
	system   providerReferenceFunc
}

// providerRefsSnapshot captures one immutable Cipher for the lifetime of a response.
// This prevents a concurrent GATEWAY_SECRET rotation from producing mixed references
// that cannot be joined within that response. Separate HMAC namespaces ensure legacy
// physical providers cannot collide with console-owned sentinel providers.
func (s *Server) providerRefsSnapshot() providerReferences {
	cipher := s.secrets.Load()
	ref := func(namespace string) providerReferenceFunc {
		return func(provider string) string {
			return providerRefPrefix + cipher.OpaqueReference(namespace, provider)
		}
	}
	return providerReferences{
		physical: ref("provider"),
		system:   ref("provider-system"),
	}
}

func (s *Server) providerRefSnapshot() providerReferenceFunc {
	return s.providerRefsSnapshot().physical
}

// providerRef is stable across pods/restarts that share GATEWAY_SECRET and changes
// intentionally when that secret rotates. It is safe for URL path/query values and
// UI keys, but it is not a persisted provider ID and cannot be reversed to a name.
// Response handlers should use providerRefSnapshot so one response has one key epoch.
func (s *Server) providerRef(provider string) string {
	return s.providerRefSnapshot()(provider)
}

func (s *Server) systemProviderRef(provider string) string {
	return s.providerRefsSnapshot().system(provider)
}

// resolveProviderIdentifier maps what a caller sent to the stored provider name.
//
// The console is served provider names redacted, with an opaque reference in their
// place, so for those providers it can only send the reference back. Write endpoints
// that key on the name would otherwise be unreachable for exactly the providers the
// projection protects. Anything that is not a reference is taken as the name itself,
// which keeps existing callers working.
//
// The reference is an HMAC and cannot be reversed, so the match is made by hashing
// each configured provider and comparing in constant time.
func (s *Server) resolveProviderIdentifier(ctx context.Context, identifier string) (string, bool, error) {
	identifier = strings.TrimSpace(identifier)
	if len(identifier) != providerRefLength || !strings.HasPrefix(identifier, providerRefPrefix) {
		return identifier, identifier != "", nil
	}
	providers, err := s.db.ListProviders(ctx)
	if err != nil {
		return "", false, err
	}
	refs := s.providerRefsSnapshot()
	for _, provider := range providers {
		if subtle.ConstantTimeCompare([]byte(refs.physical(provider.Name)), []byte(identifier)) == 1 {
			return provider.Name, true, nil
		}
	}
	return "", false, nil
}
