package store

import (
	"context"
	"strings"
	"time"
)

// KnowledgeSnippet is a centrally-managed reusable prompt fragment (coding rules,
// system prompt, etc.) that clients reference by id instead of re-sending in full.
type KnowledgeSnippet struct {
	ID            string `json:"id"` // slug
	Name          string `json:"name"`
	Content       string `json:"content"`
	Enabled       bool   `json:"enabled"`
	TokenEstimate int    `json:"token_estimate"`
	UseCount      int64  `json:"use_count"`
	LastUsedAt    string `json:"last_used_at"`
	CreatedAt     string `json:"created_at"`
}

func (s *SQLStore) ListKnowledge(ctx context.Context) ([]KnowledgeSnippet, error) {
	return s.queryKnowledge(ctx, "")
}

// ActiveKnowledge returns only enabled snippets — the set used for expansion.
func (s *SQLStore) ActiveKnowledge(ctx context.Context) ([]KnowledgeSnippet, error) {
	return s.queryKnowledge(ctx, "WHERE enabled = 1")
}

func (s *SQLStore) queryKnowledge(ctx context.Context, where string) ([]KnowledgeSnippet, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, content, enabled, token_estimate, use_count, COALESCE(last_used_at, ''), created_at
		FROM knowledge_snippets `+where+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KnowledgeSnippet{}
	for rows.Next() {
		var k KnowledgeSnippet
		var enabled int
		if err := rows.Scan(&k.ID, &k.Name, &k.Content, &enabled, &k.TokenEstimate, &k.UseCount, &k.LastUsedAt, &k.CreatedAt); err != nil {
			return nil, err
		}
		k.Enabled = enabled == 1
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertKnowledge(ctx context.Context, k KnowledgeSnippet) error {
	if strings.TrimSpace(k.CreatedAt) == "" {
		k.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	enabled := 0
	if k.Enabled {
		enabled = 1
	}
	// Preserve use_count/last_used_at across edits (don't overwrite with zero).
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO knowledge_snippets (id, name, content, enabled, token_estimate, use_count, last_used_at, created_at)
		VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, enabled = excluded.enabled, token_estimate = excluded.token_estimate`),
		k.ID, k.Name, k.Content, enabled, k.TokenEstimate, k.CreatedAt)
	return err
}

func (s *SQLStore) DeleteKnowledge(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM knowledge_snippets WHERE id = ?`), id)
	return err
}

// TouchKnowledge bumps use_count and last_used_at for the given snippet ids.
// Best-effort (called asynchronously from the proxy path).
func (s *SQLStore) TouchKnowledge(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE knowledge_snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`), now, id); err != nil {
			return err
		}
	}
	return nil
}
