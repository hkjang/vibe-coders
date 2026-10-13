package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestAPIKeyRevisionIndependentSecret(t *testing.T) {
	first, peer := routingPatchStores(t)
	key := rotationSeed(t, first)
	// Even knowing the exact credential and all metadata must not suffice to
	// reconstruct the public revision without the server-held random secret.
	digest := sha256.Sum256([]byte("password"))
	key.KeyHash = hex.EncodeToString(digest[:])
	if err := first.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("fixture update failed")
	}
	revision, err := first.APIKeyRevision(t.Context(), key)
	if err != nil || len(revision) != 64 {
		t.Fatal("revision unavailable")
	}
	_, values := apiKeySnapshotPredicate(key)
	encoded, _ := json.Marshal(values)
	oldMAC := hmac.New(sha256.New, []byte(key.KeyHash))
	_, _ = oldMAC.Write(encoded)
	if revision == hex.EncodeToString(oldMAC.Sum(nil)) {
		t.Fatal("public revision remains an offline credential verifier")
	}
	secret, err := first.apiKeyRevisionSecret(t.Context())
	if err != nil || len(secret) != 32 {
		t.Fatal("private random secret unavailable")
	}
	public, err := first.ListAPIKeys(t.Context())
	if err != nil || len(public) != 1 || public[0].Revision != revision {
		t.Fatal("public listing revision mismatch")
	}
	serialized, _ := json.Marshal(public)
	if strings.Contains(string(serialized), hex.EncodeToString(secret)) || strings.Contains(string(serialized), key.KeyHash) {
		t.Fatal("public key metadata exposed private verification material")
	}
	// Independent pools have no shared process cache and must agree. Concurrent
	// initialization cannot replace the secret or invalidate a reviewed snapshot.
	var wg sync.WaitGroup
	for _, db := range []*SQLStore{first, peer} {
		wg.Go(func() {
			if err := db.ensureAPIKeyRevisionSecret(t.Context()); err != nil {
				t.Error("concurrent initialization failed")
			}
		})
	}
	wg.Wait()
	if got, err := peer.APIKeyRevision(t.Context(), key); err != nil || got != revision {
		t.Fatal("revision changed across independent pools or initialization")
	}
	if err := first.Migrate(t.Context()); err != nil {
		t.Fatal("repeat migration failed")
	}
	if got, err := peer.APIKeyRevision(t.Context(), key); err != nil || got != revision {
		t.Fatal("repeat migration replaced revision secret")
	}
	other := openStoreForTest(t)
	defer other.Close()
	if got, err := other.APIKeyRevision(t.Context(), key); err != nil || got == revision {
		t.Fatal("unrelated databases share revision protection")
	}
	key.Name += " changed"
	if got, err := first.APIKeyRevision(t.Context(), key); err != nil || got == revision {
		t.Fatal("revision failed to bind the reviewed snapshot")
	}
}

func TestAPIKeyRevisionUnavailableFailsClosed(t *testing.T) {
	for _, value := range []string{"", "bad-hex", strings.Repeat("a", 62), "missing"} {
		t.Run(value, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			key := rotationSeed(t, db)
			var err error
			if value == "missing" {
				_, err = db.db.ExecContext(t.Context(), `DELETE FROM api_key_revision_secret`)
			} else {
				_, err = db.db.ExecContext(t.Context(), db.bind(`UPDATE api_key_revision_secret SET secret = ?`), value)
			}
			if err != nil {
				t.Fatal("failure fixture setup failed")
			}
			if revision, err := db.APIKeyRevision(t.Context(), key); err == nil || revision != "" {
				t.Fatal("unprotected revision returned")
			}
			if keys, err := db.ListAPIKeys(t.Context()); err == nil || keys != nil {
				t.Fatal("unprotected catalog returned")
			}
		})
	}
}
