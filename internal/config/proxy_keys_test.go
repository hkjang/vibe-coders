package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
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

func TestLoadRejectsNonBlankProxyKeysWithoutValidSecret(t *testing.T) {
	for _, raw := range []string{"private-name:", "private-name:   ", "private-name::owner:team", ",,private-name:,"} {
		t.Run(hashOf(raw)[:8], func(t *testing.T) {
			t.Setenv("PROXY_API_KEYS", raw)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), "PROXY_API_KEYS must contain at least one non-empty key") {
				t.Fatalf("Load() error = %v, want stable invalid PROXY_API_KEYS error", err)
			}
			if strings.Contains(err.Error(), "private-name") || strings.Contains(err.Error(), raw) {
				t.Fatalf("Load() error leaked configured metadata: %q", err)
			}
		})
	}
}

func TestLoadProxyKeysBlankAndMixedCompatibility(t *testing.T) {
	t.Run("blank remains disabled", func(t *testing.T) {
		t.Setenv("PROXY_API_KEYS", "   ")
		cfg, err := Load()
		if err != nil || cfg.Auth.ProxyAPIKeys != nil {
			t.Fatalf("Load() proxy keys = %+v, %v; want nil without error", cfg.Auth.ProxyAPIKeys, err)
		}
	})
	t.Run("valid entry survives invalid slots", func(t *testing.T) {
		t.Setenv("PROXY_API_KEYS", "broken: , valid : valid-secret : owner : team , :orphan")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Auth.ProxyAPIKeys) != 1 || cfg.Auth.ProxyAPIKeys[0].Name != "valid" ||
			cfg.Auth.ProxyAPIKeys[0].KeyHash != hashOf("valid-secret") {
			t.Fatalf("Load() proxy keys = %+v, want the single valid entry", cfg.Auth.ProxyAPIKeys)
		}
	})
}

func TestLoadHistoricalKeyPrefixes(t *testing.T) {
	t.Setenv("AUTH_HISTORICAL_KEY_PREFIXES", " oldfoo_ , legacy , 긴접두사 ")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"oldfoo_", "legacy", "긴접두사"}
	if strings.Join(cfg.Auth.HistoricalKeyPrefixes, ",") != strings.Join(want, ",") {
		t.Fatalf("historical key prefixes = %#v, want %#v", cfg.Auth.HistoricalKeyPrefixes, want)
	}
}

func TestLoadRejectsInvalidGeneratedKeyPrefixesWithoutLeakingValues(t *testing.T) {
	tests := []struct {
		name    string
		envName string
		value   string
		want    string
	}{
		{name: "API prefix byte overflow", envName: "AUTH_API_KEY_PREFIX", value: strings.Repeat("한", 171), want: "AUTH_API_KEY_PREFIX"},
		{name: "service prefix whitespace", envName: "AUTH_SERVICE_KEY_PREFIX", value: "service key_", want: "AUTH_SERVICE_KEY_PREFIX"},
		{name: "API prefix control character", envName: "AUTH_API_KEY_PREFIX", value: "corp_\n", want: "AUTH_API_KEY_PREFIX"},
		{name: "historical prefix byte overflow", envName: "AUTH_HISTORICAL_KEY_PREFIXES", value: strings.Repeat("한", 171), want: "AUTH_HISTORICAL_KEY_PREFIXES"},
		{name: "historical prefix whitespace", envName: "AUTH_HISTORICAL_KEY_PREFIXES", value: "old key_", want: "AUTH_HISTORICAL_KEY_PREFIXES"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(test.envName, test.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Load() error = %v, want stable %s validation error", err, test.want)
			}
			if strings.Contains(err.Error(), test.value) {
				t.Fatalf("Load() error leaked credential prefix metadata: %q", err)
			}
		})
	}
}

func TestLoadRejectsTooManyHistoricalKeyPrefixes(t *testing.T) {
	prefixes := make([]string, maxHistoricalKeyPrefixes+1)
	for index := range prefixes {
		prefixes[index] = fmt.Sprintf("old%d_", index)
	}
	t.Setenv("AUTH_HISTORICAL_KEY_PREFIXES", strings.Join(prefixes, ","))
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "AUTH_HISTORICAL_KEY_PREFIXES must contain at most 60 entries") {
		t.Fatalf("Load() error = %v, want bounded historical-prefix count", err)
	}
}
