package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PromptTemplate is a centrally-managed standard prompt (e.g. 리팩터링, 테스트 생성,
// 보안 점검, 문서화) that teams reuse instead of re-inventing prompts per request.
type PromptTemplate struct {
	ID          string `json:"id"` // slug
	Name        string `json:"name"`
	Category    string `json:"category"`
	Description string `json:"description"`
	Body        string `json:"body"`
	Enabled     bool   `json:"enabled"`
	UseCount    int64  `json:"use_count"`
	LastUsedAt  string `json:"last_used_at"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// ListPromptTemplates returns all templates ordered by category then name.
func (s *SQLStore) ListPromptTemplates(ctx context.Context, onlyEnabled bool) ([]PromptTemplate, error) {
	where := ""
	if onlyEnabled {
		where = "WHERE enabled = 1"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, category, COALESCE(description, ''), body, enabled, use_count, COALESCE(last_used_at, ''), created_at, updated_at
		FROM prompt_templates `+where+` ORDER BY category, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTemplate{}
	for rows.Next() {
		var t PromptTemplate
		var enabled int
		if err := rows.Scan(&t.ID, &t.Name, &t.Category, &t.Description, &t.Body, &enabled, &t.UseCount, &t.LastUsedAt, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		t.Enabled = enabled == 1
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetPromptTemplate returns a single template by id.
func (s *SQLStore) GetPromptTemplate(ctx context.Context, id string) (PromptTemplate, bool, error) {
	var t PromptTemplate
	var enabled int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, category, COALESCE(description, ''), body, enabled, use_count, COALESCE(last_used_at, ''), created_at, updated_at
		FROM prompt_templates WHERE id = ?`), id).
		Scan(&t.ID, &t.Name, &t.Category, &t.Description, &t.Body, &enabled, &t.UseCount, &t.LastUsedAt, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptTemplate{}, false, nil
	}
	if err != nil {
		return PromptTemplate{}, false, err
	}
	t.Enabled = enabled == 1
	return t, true, nil
}

// UpsertPromptTemplate inserts or updates a template, preserving use_count.
func (s *SQLStore) UpsertPromptTemplate(ctx context.Context, t PromptTemplate) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if strings.TrimSpace(t.CreatedAt) == "" {
		t.CreatedAt = now
	}
	if strings.TrimSpace(t.Category) == "" {
		t.Category = "custom"
	}
	enabled := 0
	if t.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_templates (id, name, category, description, body, enabled, use_count, last_used_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, description = excluded.description, body = excluded.body, enabled = excluded.enabled, updated_at = excluded.updated_at`),
		t.ID, t.Name, t.Category, t.Description, t.Body, enabled, t.CreatedAt, now)
	return err
}

// DeletePromptTemplate removes a template.
func (s *SQLStore) DeletePromptTemplate(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM prompt_templates WHERE id = ?`), id)
	return err
}

// TouchPromptTemplate bumps use_count/last_used_at. Best-effort.
func (s *SQLStore) TouchPromptTemplate(ctx context.Context, id string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE prompt_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`), now, id)
	return err
}
