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
