package proxy

import (
	"reflect"
	"testing"
)

func TestEndpointKind(t *testing.T) {
	cases := map[string]string{
		"/v1/chat/completions": "chat",
		"/v1/embeddings":       "embedding",
		"/v1/responses":        "responses",
		"/v1/messages":         "messages",
		"/v1/models":           "models",
	}
	for endpoint, want := range cases {
		if got := endpointKind(endpoint); got != want {
			t.Errorf("endpointKind(%q) = %q, want %q", endpoint, got, want)
		}
	}
}

func TestSessionRCASummary(t *testing.T) {
	// Clean session → 정상.
	clean := sessionRCASummary(10, 0, 0, 0, 0, 2, 1000)
	if clean["verdict"] != "정상" {
		t.Fatalf("clean session verdict = %v, want 정상", clean["verdict"])
	}
	// Errors only → 주의.
	warn := sessionRCASummary(10, 3, 0, 0, 0, 1, 0)
	if warn["verdict"] != "주의" {
		t.Fatalf("error session verdict = %v, want 주의", warn["verdict"])
	}
	// Any security/risk signal → 위험.
	for _, m := range []map[string]any{
		sessionRCASummary(5, 0, 1, 0, 0, 1, 0),
		sessionRCASummary(5, 0, 0, 1, 0, 1, 0),
		sessionRCASummary(5, 0, 0, 0, 1, 1, 0),
	} {
		if m["verdict"] != "위험" {
			t.Fatalf("risk session verdict = %v, want 위험", m["verdict"])
		}
	}
	// Findings are populated for a risky session.
	risky := sessionRCASummary(8, 2, 1, 1, 1, 2, 50000)
	fs, ok := risky["findings"].([]string)
	if !ok || len(fs) < 4 {
		t.Fatalf("risky session should list findings, got %v", risky["findings"])
	}
}

func TestKeysOfSorted(t *testing.T) {
	got := keysOf(map[string]bool{"openai": true, "anthropic": true, "azure": true})
	want := []string{"anthropic", "azure", "openai"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("keysOf = %v, want %v", got, want)
	}
	if len(keysOf(map[string]bool{})) != 0 {
		t.Fatal("empty set should yield empty slice")
	}
}
