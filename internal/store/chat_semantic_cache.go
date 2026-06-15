package store

import (
	"context"
	"encoding/json"
	"math"
	"time"
)

// ChatSemanticHit is a stored chat response matched by embedding similarity.
type ChatSemanticHit struct {
	Body        []byte
	ContentType string
	Similarity  float64
}

// PutChatSemanticEntry stores a prompt embedding + the response it produced, for
// embedding-similarity reuse. Best-effort; oversized vectors/bodies are the caller's
// concern.
func (s *SQLStore) PutChatSemanticEntry(ctx context.Context, id, model string, embedding []float64, contentType string, body []byte, ttl time.Duration) error {
	vec, err := json.Marshal(embedding)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx, s.bind(`INSERT INTO chat_semantic_cache (id, model, embedding, content_type, body, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding, content_type = excluded.content_type, body = excluded.body, expires_at = excluded.expires_at`),
		id, model, string(vec), contentType, body, now.Format(time.RFC3339Nano), now.Add(ttl).Format(time.RFC3339Nano))
	return err
}

// SearchChatSemantic scans up to maxCandidates recent non-expired entries for the model
// and returns the most similar response whose cosine similarity meets the threshold.
func (s *SQLStore) SearchChatSemantic(ctx context.Context, model string, query []float64, threshold float64, maxCandidates int) (ChatSemanticHit, bool, error) {
	if len(query) == 0 {
		return ChatSemanticHit{}, false, nil
	}
	if maxCandidates <= 0 || maxCandidates > 5000 {
		maxCandidates = 200
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT embedding, content_type, body, expires_at FROM chat_semantic_cache
		WHERE model = ? ORDER BY created_at DESC LIMIT ?`), model, maxCandidates)
	if err != nil {
		return ChatSemanticHit{}, false, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	qNorm := vecNorm(query)
	best := ChatSemanticHit{}
	found := false
	for rows.Next() {
		var vecJSON, contentType, expires string
		var body []byte
		if err := rows.Scan(&vecJSON, &contentType, &body, &expires); err != nil {
			return ChatSemanticHit{}, false, err
		}
		if exp, ok := parseStoredTime(expires); ok && now.After(exp) {
			continue
		}
		var vec []float64
		if err := json.Unmarshal([]byte(vecJSON), &vec); err != nil || len(vec) != len(query) {
			continue
		}
		sim := cosineSimilarity(query, vec, qNorm)
		if sim >= threshold && sim > best.Similarity {
			best = ChatSemanticHit{Body: body, ContentType: contentType, Similarity: sim}
			found = true
		}
	}
	return best, found, rows.Err()
}

// PurgeChatSemanticExpired deletes expired semantic-cache entries.
func (s *SQLStore) PurgeChatSemanticExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM chat_semantic_cache WHERE expires_at < ?`), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func vecNorm(v []float64) float64 {
	var s float64
	for _, x := range v {
		s += x * x
	}
	return math.Sqrt(s)
}

// cosineSimilarity returns the cosine similarity of a and b; aNorm is the precomputed
// norm of a. Returns 0 when either vector has zero magnitude.
func cosineSimilarity(a, b []float64, aNorm float64) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, bNorm float64
	for i := range a {
		dot += a[i] * b[i]
		bNorm += b[i] * b[i]
	}
	bNorm = math.Sqrt(bNorm)
	if aNorm == 0 || bNorm == 0 {
		return 0
	}
	return dot / (aNorm * bNorm)
}
