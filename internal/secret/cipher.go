package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
)

type Cipher struct {
	aead         cipher.AEAD
	referenceKey [sha256.Size]byte
}

func New(passphrase string) (*Cipher, error) {
	sum := sha256.Sum256([]byte(passphrase))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	referenceMAC := hmac.New(sha256.New, []byte(passphrase))
	_, _ = referenceMAC.Write([]byte("vibe-coders/opaque-reference/v1"))
	var referenceKey [sha256.Size]byte
	copy(referenceKey[:], referenceMAC.Sum(nil))
	return &Cipher{aead: aead, referenceKey: referenceKey}, nil
}

// OpaqueReference returns a deterministic, keyed identifier without exposing the
// source value or a reversible/non-keyed digest. Equal gateway secrets produce equal
// references across pods and restarts; rotating GATEWAY_SECRET deliberately rotates
// every reference, so callers must treat them as console-session identifiers rather
// than durable database keys.
func (c *Cipher) OpaqueReference(namespace, value string) string {
	mac := hmac.New(sha256.New, c.referenceKey[:])
	_, _ = mac.Write([]byte(namespace))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (c *Cipher) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return "v1:" + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (c *Cipher) Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	if !strings.HasPrefix(ciphertext, "v1:") {
		return "", fmt.Errorf("unsupported secret format")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(ciphertext, "v1:"))
	if err != nil {
		return "", err
	}
	nonceSize := c.aead.NonceSize()
	if len(raw) < nonceSize {
		return "", fmt.Errorf("invalid secret payload")
	}
	nonce := raw[:nonceSize]
	payload := raw[nonceSize:]
	opened, err := c.aead.Open(nil, nonce, payload, nil)
	if err != nil {
		return "", err
	}
	return string(opened), nil
}
