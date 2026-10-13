package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// This private, database-wide key is independent of every API credential. Keep
// it outside admin_settings: settings exports and public key listings must never
// expose it. Persistence makes reviewed snapshots portable across pods/restarts.
func (s *SQLStore) ensureAPIKeyRevisionSecret(ctx context.Context) error {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return errors.New("could not initialize API key revision protection")
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO api_key_revision_secret (id, secret) VALUES (1, ?) ON CONFLICT(id) DO NOTHING`), hex.EncodeToString(secret)); err != nil {
		return errors.New("could not persist API key revision protection")
	}
	_, err := s.apiKeyRevisionSecret(ctx)
	return err
}

func (s *SQLStore) apiKeyRevisionSecret(ctx context.Context) ([]byte, error) {
	var encoded string
	if err := s.db.QueryRowContext(ctx, `SELECT secret FROM api_key_revision_secret WHERE id = 1`).Scan(&encoded); err != nil {
		return nil, errors.New("API key revision protection unavailable")
	}
	secret, err := hex.DecodeString(encoded)
	if err != nil || len(secret) != 32 {
		return nil, errors.New("API key revision protection invalid")
	}
	return secret, nil
}

// APIKeyRevision binds the complete snapshot to a server-held random secret.
// Using the credential hash as the HMAC key would make the public revision an
// offline verifier for guessed low-entropy imported credentials.
func (s *SQLStore) APIKeyRevision(ctx context.Context, key APIKeyRecord) (string, error) {
	secret, err := s.apiKeyRevisionSecret(ctx)
	if err != nil {
		return "", err
	}
	return apiKeyRevision(key, secret)
}

func apiKeyRevision(key APIKeyRecord, secret []byte) (string, error) {
	_, values := apiKeySnapshotPredicate(key)
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", errors.New("API key revision snapshot invalid")
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("vibe-coders/api-key-revision/v1\x00"))
	_, _ = mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil)), nil
}
