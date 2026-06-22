package proxy

import (
	"reflect"
	"testing"
)

func TestSchemaPropKeys(t *testing.T) {
	keys := schemaPropKeys(`{"type":"object","properties":{"b":{"type":"string"},"a":{"type":"integer"}}}`)
	if !reflect.DeepEqual(keys, []string{"a", "b"}) {
		t.Fatalf("expected sorted [a b], got %v", keys)
	}
	if schemaPropKeys("") != nil {
		t.Fatal("empty schema should yield nil")
	}
	if schemaPropKeys("not json") != nil {
		t.Fatal("invalid schema should yield nil")
	}
	// No properties -> empty (non-nil) slice.
	if k := schemaPropKeys(`{"type":"object"}`); len(k) != 0 {
		t.Fatalf("no-properties schema should be empty, got %v", k)
	}
}

func TestDiffKeys(t *testing.T) {
	declared := []string{"model", "prompt", "extra"}
	live := []string{"model", "prompt", "messages"}
	if got := diffKeys(declared, live); !reflect.DeepEqual(got, []string{"extra"}) {
		t.Fatalf("declared_only = %v, want [extra]", got)
	}
	if got := diffKeys(live, declared); !reflect.DeepEqual(got, []string{"messages"}) {
		t.Fatalf("live_only = %v, want [messages]", got)
	}
	if got := diffKeys([]string{"a"}, []string{"a"}); len(got) != 0 {
		t.Fatalf("identical sets should diff empty, got %v", got)
	}
}

// The drift validator must recognize the live gateway tool names so a matching contract reports ok.
func TestGatewayToolDefsHaveSchemas(t *testing.T) {
	found := false
	for _, td := range gatewayToolDefs() {
		if td.Name == "gateway_chat" {
			found = true
			keys := schemaPropKeys(string(td.InputSchema))
			if len(keys) == 0 {
				t.Fatal("gateway_chat should advertise input properties")
			}
		}
	}
	if !found {
		t.Fatal("gateway_chat tool missing from gatewayToolDefs")
	}
}
