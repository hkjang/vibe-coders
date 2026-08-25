package store

import (
	"context"
	"time"
)

// PromptProduct is a recurring prompt cluster promoted into a named, reusable prompt
// template ("product"). It records provenance (the source fingerprint) and a usage
// snapshot taken at promotion time, and points at the prompt_templates row that holds
// the canonical body. Adoption (template use_count / last_used) is joined on read.
type PromptProduct struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	Category          string `json:"category"`
	SourceFingerprint string `json:"source_fingerprint"`
	TemplateID        string `json:"template_id"`
	RequestCount      int64  `json:"request_count"`  // snapshot at promotion
	DistinctUsers     int64  `json:"distinct_users"` // snapshot at promotion
	CreatedBy         string `json:"created_by"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
	// Adoption (joined from prompt_templates, not stored on this row).
	TemplateUseCount int64  `json:"template_use_count"`
	TemplateLastUsed string `json:"template_last_used"`
}

// ListPromptProducts returns products newest-first, joined with their template's
// adoption counters so callers can see how much each productized prompt is used.
func (s *SQLStore) ListPromptProducts(ctx context.Context) ([]PromptProduct, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.name, COALESCE(p.description, ''), p.category,
			COALESCE(p.source_fingerprint, ''), p.template_id, p.request_count, p.distinct_users,
			COALESCE(p.created_by, ''), p.created_at, p.updated_at,
			COALESCE(t.use_count, 0), COALESCE(t.last_used_at, '')
		FROM prompt_products p
		LEFT JOIN prompt_templates t ON t.id = p.template_id
		ORDER BY p.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptProduct{}
	for rows.Next() {
		var p PromptProduct
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Category, &p.SourceFingerprint, &p.TemplateID,
			&p.RequestCount, &p.DistinctUsers, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
			&p.TemplateUseCount, &p.TemplateLastUsed); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpsertPromptProduct inserts or updates a product row, preserving created_at.
func (s *SQLStore) UpsertPromptProduct(ctx context.Context, p PromptProduct) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if p.CreatedAt == "" {
		p.CreatedAt = now
	}
	if p.Category == "" {
		p.Category = "product"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_products
			(id, name, description, category, source_fingerprint, template_id, request_count, distinct_users, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				description = excluded.description,
				category = excluded.category,
				source_fingerprint = excluded.source_fingerprint,
				template_id = excluded.template_id,
				request_count = excluded.request_count,
				distinct_users = excluded.distinct_users,
				updated_at = excluded.updated_at`),
		p.ID, p.Name, p.Description, p.Category, p.SourceFingerprint, p.TemplateID,
		p.RequestCount, p.DistinctUsers, p.CreatedBy, p.CreatedAt, now)
	return err
}

// DeletePromptProduct removes a product row (the underlying template is left intact).
func (s *SQLStore) DeletePromptProduct(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM prompt_products WHERE id = ?`), id)
	return err
}

// PromptProductFingerprints returns the set of source fingerprints already promoted,
// so candidate listings can mark which recurring prompts are already productized.
func (s *SQLStore) PromptProductFingerprints(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT source_fingerprint FROM prompt_products WHERE COALESCE(source_fingerprint, '') <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			return nil, err
		}
		out[fp] = true
	}
	return out, rows.Err()
}

// PromptFingerprintReach returns the request count and distinct caller (api_key_id)
// count for a fingerprint since `since` — used to snapshot a product's reach at
// promotion time.
func (s *SQLStore) PromptFingerprintReach(ctx context.Context, fingerprint string, since time.Time) (requests int64, distinctUsers int64, err error) {
	err = s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*), COUNT(DISTINCT NULLIF(api_key_id, ''))
		FROM request_logs
		WHERE prompt_fingerprint = ? AND created_at >= ?`),
		fingerprint, since.UTC().Format(time.RFC3339Nano)).Scan(&requests, &distinctUsers)
	return requests, distinctUsers, err
}
