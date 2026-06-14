package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// Text2SQLCacheKey derives a deterministic cache key for a preview generation from
// the question, the resolved schema, and the profile mode. Schema version is folded
// in so a schema change invalidates stale cached SQL, and the permission + glossary
// hashes are folded in so SQL generated under one subject's access (or one glossary
// revision) is never reused for a subject whose effective access or vocabulary differs.
func Text2SQLCacheKey(question, schemaName, mode string, schemaVersion int, permissionHash, glossaryHash string) string {
	h := sha256.Sum256([]byte(question + "\x00" + schemaName + "\x00" + mode + "\x00" + itoaStore(schemaVersion) + "\x00" + permissionHash + "\x00" + glossaryHash))
	return hex.EncodeToString(h[:])
}

// GetText2SQLCache returns a non-expired cached SQL for a key, bumping its hit count.
func (s *SQLStore) GetText2SQLCache(ctx context.Context, key string) (string, bool, error) {
	var sql, expires string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT generated_sql, expires_at FROM text2sql_cache WHERE cache_key = ?`), key).Scan(&sql, &expires)
	if err != nil {
		return "", false, nil // miss (incl. no rows)
	}
	if exp, ok := parseStoredTime(expires); ok && time.Now().UTC().After(exp) {
		return "", false, nil // expired
	}
	_, _ = s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_cache SET hits = hits + 1 WHERE cache_key = ?`), key)
	return sql, true, nil
}

// PutText2SQLCache stores a generated SQL under a key with a TTL.
func (s *SQLStore) PutText2SQLCache(ctx context.Context, key, schemaName, mode, sql string, ttl time.Duration) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_cache (cache_key, schema_name, mode, generated_sql, hits, created_at, expires_at)
		VALUES (?, ?, ?, ?, 0, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET generated_sql = excluded.generated_sql, expires_at = excluded.expires_at`),
		key, schemaName, mode, sql, now.Format(time.RFC3339Nano), now.Add(ttl).Format(time.RFC3339Nano))
	return err
}

func itoaStore(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
