package secret

import (
	"regexp"
	"testing"
)

func TestCipherRoundTripAndWrongSecret(t *testing.T) {
	cipherA, err := New("secret-a")
	if err != nil {
		t.Fatal(err)
	}
	cipherB, err := New("secret-b")
	if err != nil {
		t.Fatal(err)
	}

	encrypted, err := cipherA.Encrypt("upstream-key")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == "upstream-key" {
		t.Fatal("ciphertext should not equal plaintext")
	}

	opened, err := cipherA.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if opened != "upstream-key" {
		t.Fatalf("unexpected plaintext %q", opened)
	}

	if _, err := cipherB.Decrypt(encrypted); err == nil {
		t.Fatal("expected decrypt with wrong secret to fail")
	}
}

func TestOpaqueReferenceIsStableAndKeyed(t *testing.T) {
	cipherA1, err := New("shared-gateway-secret")
	if err != nil {
		t.Fatal(err)
	}
	cipherA2, err := New("shared-gateway-secret")
	if err != nil {
		t.Fatal(err)
	}
	cipherB, err := New("rotated-gateway-secret")
	if err != nil {
		t.Fatal(err)
	}
	first := cipherA1.OpaqueReference("provider", "sk-ant-private-provider")
	if first != cipherA1.OpaqueReference("provider", "sk-ant-private-provider") || first != cipherA2.OpaqueReference("provider", "sk-ant-private-provider") {
		t.Fatal("same gateway secret did not produce a stable cross-instance reference")
	}
	if first == cipherB.OpaqueReference("provider", "sk-ant-private-provider") {
		t.Fatal("gateway secret rotation did not rotate the reference")
	}
	if first == cipherA1.OpaqueReference("provider", "different-provider") || first == cipherA1.OpaqueReference("other", "sk-ant-private-provider") {
		t.Fatal("reference did not bind both namespace and source value")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(first) || first == "sk-ant-private-provider" {
		t.Fatalf("opaque reference is not bounded base64url: %q", first)
	}
}
