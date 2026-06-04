package secret

import "testing"

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
