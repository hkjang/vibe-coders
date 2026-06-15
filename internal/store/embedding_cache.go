package store

import (
	"context"
	"database/sql"
	"time"
)

type EmbeddingCacheHit struct {
	CacheKey    string
	Model       string
	ContentType string
	Body        []byte
	Hits        int64
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

func (s *SQLStore) GetEmbeddingCache(ctx context.Context, key string) (EmbeddingCacheHit, bool, error) {
	var hit EmbeddingCacheHit
	var createdAt, expiresAt string
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT cache_key, model, content_type, response_body, hits, created_at, expires_at
		FROM embedding_cache
		WHERE cache_key = ? AND expires_at > ?`),
		key, time.Now().UTC().Format(time.RFC3339Nano),
	).Scan(&hit.CacheKey, &hit.Model, &hit.ContentType, &hit.Body, &hit.Hits, &createdAt, &expiresAt)
	if err == sql.ErrNoRows {
		return EmbeddingCacheHit{}, false, nil
	}
	if err != nil {
		return EmbeddingCacheHit{}, false, err
	}
	if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		hit.CreatedAt = parsed
	}
	if parsed, err := time.Parse(time.RFC3339Nano, expiresAt); err == nil {
		hit.ExpiresAt = parsed
	}
	// best-effort hit counter (don't fail the lookup if this fails)
	_, _ = s.db.ExecContext(ctx, s.bind(`UPDATE embedding_cache SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?`),
		time.Now().UTC().Format(time.RFC3339Nano), key)
	return hit, true, nil
}

func (s *SQLStore) PutEmbeddingCache(ctx context.Context, key, model, contentType string, body []byte, ttl time.Duration) error {
	now := time.Now().UTC()
	expires := now.Add(ttl)
	_, err := s.db.ExecContext(ctx, s.bind(`
		INSERT INTO embedding_cache (cache_key, model, content_type, response_body, hits, byte_size, created_at, expires_at)
		VALUES (?, ?, ?, ?, 0, ?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET
			model = excluded.model,
			content_type = excluded.content_type,
			response_body = excluded.response_body,
			byte_size = excluded.byte_size,
			expires_at = excluded.expires_at`),
		key, model, contentType, body, len(body), now.Format(time.RFC3339Nano), expires.Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) PurgeExpiredEmbeddings(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM embedding_cache WHERE expires_at <= ?`),
		time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

type EmbeddingCacheStats struct {
	Entries   int64               `json:"entries"`
	Bytes     int64               `json:"bytes"`
	TotalHits int64               `json:"total_hits"`
	TopModels []EmbeddingCacheTop `json:"top_models"`
}

type EmbeddingCacheTop struct {
	Model   string `json:"model"`
	Entries int64  `json:"entries"`
	Hits    int64  `json:"hits"`
}

func (s *SQLStore) EmbeddingCacheStats(ctx context.Context) (EmbeddingCacheStats, error) {
	var stats EmbeddingCacheStats
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(byte_size), 0), COALESCE(SUM(hits), 0) FROM embedding_cache`).
		Scan(&stats.Entries, &stats.Bytes, &stats.TotalHits)
	if err != nil {
		return stats, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT model, COUNT(*), COALESCE(SUM(hits), 0) FROM embedding_cache GROUP BY model ORDER BY COUNT(*) DESC LIMIT 10`)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	stats.TopModels = []EmbeddingCacheTop{}
	for rows.Next() {
		var t EmbeddingCacheTop
		if err := rows.Scan(&t.Model, &t.Entries, &t.Hits); err != nil {
			return stats, err
		}
		stats.TopModels = append(stats.TopModels, t)
	}
	return stats, rows.Err()
}
