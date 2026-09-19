package proxy

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The discovery and JWKS caches sit on every SSO request — the web sign-in and,
// since /mcp accepts Keycloak access tokens, every MCP call with one. What these
// tests pin down is that a request the cache can answer never waits for the
// identity provider: not for a fetch another request started, and not for the
// refresh its own expired entry needs.

// gatedIdP is a fake Keycloak whose discovery and JWKS handlers can be held —
// a slow identity provider on demand — and that counts what it was asked.
type gatedIdP struct {
	*httptest.Server
	key      *rsa.PrivateKey
	discHits atomic.Int32
	jwksHits atomic.Int32
	discFail atomic.Bool

	mu      sync.Mutex
	release chan struct{} // non-nil while held; closed to let handlers answer
	arrived chan struct{} // one send per handler that started waiting
}

func newGatedIdP(t *testing.T) *gatedIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &gatedIdP{key: key, arrived: make(chan struct{}, 16)}
	mux := http.NewServeMux()
	mux.HandleFunc("/realms/vibe/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		idp.discHits.Add(1)
		idp.wait()
		if idp.discFail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer":                 idp.issuer(),
			"authorization_endpoint": idp.issuer() + "/protocol/openid-connect/auth",
			"token_endpoint":         idp.issuer() + "/protocol/openid-connect/token",
			"jwks_uri":               idp.jwksURI(),
		})
	})
	mux.HandleFunc("/realms/vibe/protocol/openid-connect/certs", func(w http.ResponseWriter, _ *http.Request) {
		idp.jwksHits.Add(1)
		idp.wait()
		writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": "idp-kid", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}}})
	})
	idp.Server = httptest.NewServer(mux)
	t.Cleanup(func() {
		idp.open()
		idp.Close()
	})
	invalidateOIDCCaches()
	t.Cleanup(invalidateOIDCCaches)
	return idp
}

func (idp *gatedIdP) issuer() string  { return idp.URL + "/realms/vibe" }
func (idp *gatedIdP) jwksURI() string { return idp.issuer() + "/protocol/openid-connect/certs" }

// hold makes every handler wait until open is called.
func (idp *gatedIdP) hold() {
	idp.mu.Lock()
	defer idp.mu.Unlock()
	if idp.release == nil {
		idp.release = make(chan struct{})
	}
}

func (idp *gatedIdP) open() {
	idp.mu.Lock()
	defer idp.mu.Unlock()
	if idp.release != nil {
		close(idp.release)
		idp.release = nil
	}
}

func (idp *gatedIdP) wait() {
	idp.mu.Lock()
	release := idp.release
	idp.mu.Unlock()
	if release == nil {
		return
	}
	idp.arrived <- struct{}{}
	<-release
}

// awaitArrival fails the test unless a handler started waiting within the deadline.
func (idp *gatedIdP) awaitArrival(t *testing.T) {
	t.Helper()
	select {
	case <-idp.arrived:
	case <-time.After(5 * time.Second):
		idp.open()
		t.Fatal("the identity provider never received the fetch")
	}
}

// mustFinishFast runs fn and fails if it does not return within a second — the
// signature of a caller waiting on the identity provider it should not need.
func mustFinishFast(t *testing.T, idp *gatedIdP, what string, fn func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	case <-time.After(time.Second):
		idp.open()
		t.Fatalf("%s waited for the identity provider", what)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not happen in time", what)
}

func primeJWKS(t *testing.T, idp *gatedIdP) {
	t.Helper()
	if _, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "idp-kid"); err != nil {
		t.Fatal(err)
	}
}

// ageJWKS backdates the cached document by age: past oidcNegativeTTL an unknown
// kid may refetch again; past oidcCacheTTL the entry is due a refresh.
func ageJWKS(idp *gatedIdP, age time.Duration) {
	jwksMu.Lock()
	defer jwksMu.Unlock()
	entry := jwksCache[idp.issuer()+"\x00"+idp.jwksURI()]
	entry.fetched = time.Now().Add(-age)
	jwksCache[idp.issuer()+"\x00"+idp.jwksURI()] = entry
}

func TestKeycloakJWKSCacheHitDoesNotWaitForAFetchInFlight(t *testing.T) {
	idp := newGatedIdP(t)
	primeJWKS(t, idp)
	ageJWKS(idp, oidcNegativeTTL+time.Second)

	// A token with a kid the cache has never seen forces a fetch; the provider holds it.
	idp.hold()
	unknown := make(chan error, 1)
	go func() {
		_, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "rotated-away")
		unknown <- err
	}()
	idp.awaitArrival(t)

	// Meanwhile a token signed with the cached key must verify without queueing
	// behind that fetch.
	mustFinishFast(t, idp, "cached kid while another fetch is in flight", func() error {
		_, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "idp-kid")
		return err
	})

	idp.open()
	if err := <-unknown; err == nil {
		t.Fatal("a kid the JWKS does not list must not verify")
	}
}

func TestKeycloakJWKSExpiredEntryIsServedWhileRefreshedInBackground(t *testing.T) {
	idp := newGatedIdP(t)
	primeJWKS(t, idp)
	ageJWKS(idp, oidcCacheTTL+time.Minute)

	idp.hold()
	mustFinishFast(t, idp, "cached kid past its TTL", func() error {
		_, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "idp-kid")
		return err
	})
	// The refresh happens, once, without the caller.
	idp.awaitArrival(t)
	idp.open()
	eventually(t, "background JWKS refresh", func() bool {
		jwksMu.Lock()
		defer jwksMu.Unlock()
		return time.Since(jwksCache[idp.issuer()+"\x00"+idp.jwksURI()].fetched) < time.Minute
	})
	if hits := idp.jwksHits.Load(); hits != 2 {
		t.Fatalf("JWKS fetched %d times, want 2 (prime + one background refresh)", hits)
	}
}

func TestKeycloakJWKSUnknownKidIsNegativelyCached(t *testing.T) {
	idp := newGatedIdP(t)
	primeJWKS(t, idp)

	// Straight after a fetch the document is authoritative: a kid it does not
	// list is refused without asking again.
	if _, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "forged-kid"); err == nil {
		t.Fatal("unknown kid must not verify")
	}
	if hits := idp.jwksHits.Load(); hits != 1 {
		t.Fatalf("JWKS fetched %d times for an unknown kid right after a fetch, want 1", hits)
	}
	// Once the document is old enough that a rotation could have happened, one
	// refetch answers the miss — and only one, whatever kids follow.
	ageJWKS(idp, oidcNegativeTTL+time.Second)
	for _, kid := range []string{"forged-kid", "forged-kid", "another-forged-kid"} {
		if _, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), kid); err == nil {
			t.Fatalf("unknown kid %s must not verify", kid)
		}
	}
	if hits := idp.jwksHits.Load(); hits != 2 {
		t.Fatalf("JWKS fetched %d times for a stream of unknown kids, want 2", hits)
	}
	// The known key is unaffected.
	if _, err := keycloakJWKSKey(context.Background(), idp.issuer(), idp.jwksURI(), "idp-kid"); err != nil {
		t.Fatal(err)
	}
}

func TestKeycloakDiscoveryCacheHitDoesNotWaitForARefresh(t *testing.T) {
	idp := newGatedIdP(t)
	if _, err := keycloakDiscover(context.Background(), idp.issuer()); err != nil {
		t.Fatal(err)
	}
	discMu.Lock()
	discFetch = time.Now().Add(-oidcCacheTTL - time.Minute)
	discMu.Unlock()

	idp.hold()
	mustFinishFast(t, idp, "cached discovery past its TTL", func() error {
		disc, err := keycloakDiscover(context.Background(), idp.issuer())
		if err == nil && disc.JWKSURI != idp.jwksURI() {
			t.Errorf("stale discovery = %+v", disc)
		}
		return err
	})
	idp.awaitArrival(t)
	idp.open()
	eventually(t, "background discovery refresh", func() bool {
		discMu.Lock()
		defer discMu.Unlock()
		return time.Since(discFetch) < time.Minute
	})
	if hits := idp.discHits.Load(); hits != 2 {
		t.Fatalf("discovery fetched %d times, want 2", hits)
	}
}

func TestKeycloakDiscoveryFailureIsNegativelyCached(t *testing.T) {
	idp := newGatedIdP(t)
	idp.discFail.Store(true)

	for i := 0; i < 3; i++ {
		if _, err := keycloakDiscover(context.Background(), idp.issuer()); err == nil {
			t.Fatal("a failed discovery must be an error")
		}
	}
	if hits := idp.discHits.Load(); hits != 1 {
		t.Fatalf("discovery fetched %d times while failing, want 1 (negative cache)", hits)
	}
}

func TestKeycloakDiscoveryFetchHonoursTheCallerContext(t *testing.T) {
	idp := newGatedIdP(t)
	idp.hold()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := keycloakDiscover(ctx, idp.issuer()); err == nil {
		t.Fatal("a cancelled fetch must be an error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("cancelled discovery took %s", time.Since(start))
	}
	idp.open()
}
