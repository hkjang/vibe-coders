package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
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
	return readAPIKeyRevisionSecret(ctx, s.db)
}

type apiKeyRevisionReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readAPIKeyRevisionSecret(ctx context.Context, reader apiKeyRevisionReader) ([]byte, error) {
	var encoded string
	if err := reader.QueryRowContext(ctx, `SELECT secret FROM api_key_revision_secret WHERE id = 1`).Scan(&encoded); err != nil {
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
	return s.apiKeyRevisionWithReader(ctx, s.db, key)
}

func (s *SQLStore) apiKeyRevisionWithReader(ctx context.Context, reader apiKeyRevisionReader, key APIKeyRecord) (string, error) {
	secret, err := readAPIKeyRevisionSecret(ctx, reader)
	if err != nil {
		return "", err
	}
	var replacement, grace string
	err = reader.QueryRowContext(ctx, s.bind(`SELECT new_key_id, grace_ends_at FROM api_key_rotations WHERE old_key_id = ?`), key.ID).Scan(&replacement, &grace)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("API key rotation review unavailable")
	}
	return apiKeyRevision(key, secret, replacement, grace)
}

func apiKeyRevision(key APIKeyRecord, secret []byte, replacement, grace string) (string, error) {
	_, values := apiKeySnapshotPredicate(key)
	values = append(values, replacement, grace)
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", errors.New("API key revision snapshot invalid")
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("vibe-coders/api-key-revision/v2\x00"))
	_, _ = mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil)), nil
}
