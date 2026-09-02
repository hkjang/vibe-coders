package config

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func hashOf(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func TestParseProxyKeysDocumentedFormat(t *testing.T) {
	keys := parseProxyKeys("dev:dev-proxy-key:alice:platform,team:team-proxy-key:bob:backend")
	if len(keys) != 2 {
		t.Fatalf("parsed %d keys, want 2", len(keys))
	}
	want := hashOf("dev-proxy-key")
	if keys[0].Name != "dev" || keys[0].Owner != "alice" || keys[0].Team != "platform" {
		t.Errorf("first key = %+v, want name/owner/team dev/alice/platform", keys[0])
	}
	if keys[0].KeyHash != want || keys[0].ID != "key_"+want[:16] {
		t.Errorf("first key hash = %q/%q, want %q", keys[0].KeyHash, keys[0].ID, want)
	}
	if keys[1].Name != "team" || keys[1].KeyHash != hashOf("team-proxy-key") {
		t.Errorf("second key = %+v, want team/team-proxy-key", keys[1])
	}
}

// Operators naturally pad CSV entries with spaces. The bearer path hashes a
// trimmed token, so every field must be trimmed here or the key silently never
// authenticates.
func TestParseProxyKeysTrimsEveryField(t *testing.T) {
	keys := parseProxyKeys(" dev : dev-proxy-key : alice : platform ")
	if len(keys) != 1 {
		t.Fatalf("parsed %d keys, want 1", len(keys))
	}
	if got, want := keys[0].KeyHash, hashOf("dev-proxy-key"); got != want {
		t.Errorf("key hash = %q, want hash of the trimmed secret %q", got, want)
	}
	if keys[0].Name != "dev" || keys[0].Owner != "alice" || keys[0].Team != "platform" {
		t.Errorf("fields = %+v, want trimmed dev/alice/platform", keys[0])
	}
}

// A blank secret would register sha256("") as an active key hash, which flips
// the gateway into key-required mode over an entry no caller can present.
func TestParseProxyKeysSkipsBlankSecret(t *testing.T) {
	for _, raw := range []string{"dev:", "dev:   ", "dev::alice:platform"} {
		if keys := parseProxyKeys(raw); len(keys) != 0 {
			t.Errorf("parseProxyKeys(%q) = %+v, want no keys", raw, keys)
		}
	}
}

func TestParseProxyKeysBareSecret(t *testing.T) {
	keys := parseProxyKeys("only-secret")
	if len(keys) != 1 {
		t.Fatalf("parsed %d keys, want 1", len(keys))
	}
	if keys[0].Name != "key-1" || keys[0].KeyHash != hashOf("only-secret") {
		t.Errorf("bare entry = %+v, want name key-1 hashing the whole field", keys[0])
	}
}

func TestParseProxyKeysSkipsEmptyEntries(t *testing.T) {
	if keys := parseProxyKeys("   "); keys != nil {
		t.Errorf("blank input = %+v, want nil", keys)
	}
	keys := parseProxyKeys("a:1,,:orphan,b:2")
	if len(keys) != 2 {
		t.Fatalf("parsed %d keys, want 2", len(keys))
	}
	// The name index follows the CSV position so operators can match a key back
	// to its slot in the env var.
	if keys[0].Name != "a" || keys[1].Name != "b" {
		t.Errorf("names = %q/%q, want a/b", keys[0].Name, keys[1].Name)
	}
}
