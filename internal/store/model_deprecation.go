package store

import (
	"context"
	"strings"
	"time"
)

// ModelDeprecation marks a model (glob) as deprecated, optionally with a replacement and a
// sunset date. Before the sunset date the gateway only warns (response headers); on/after it,
// requests are auto-rewritten to the replacement (or blocked when none is set).
type ModelDeprecation struct {
	ID          string `json:"id"`
	ModelGlob   string `json:"model_glob"`  // glob matched against the requested model
	Replacement string `json:"replacement"` // model to rewrite to after sunset; empty = block
	SunsetDate  string `json:"sunset_date"` // YYYY-MM-DD (UTC); empty = warn-only indefinitely
	Message     string `json:"message"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// UpsertModelDeprecation inserts or updates a deprecation by id (id derived from model_glob).
func (s *SQLStore) UpsertModelDeprecation(ctx context.Context, d ModelDeprecation) (ModelDeprecation, error) {
	d.ModelGlob = strings.TrimSpace(d.ModelGlob)
	if d.ID == "" {
		d.ID = okfHashID("moddep", strings.ToLower(d.ModelGlob))
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	d.UpdatedAt = now
	var createdAt string
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT created_at FROM model_deprecations WHERE id = ?`), d.ID)
	if err := row.Scan(&createdAt); err == nil {
		d.CreatedAt = createdAt
	} else {
		d.CreatedAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO model_deprecations (id, model_glob, replacement, sunset_date, message, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET model_glob = excluded.model_glob, replacement = excluded.replacement,
			sunset_date = excluded.sunset_date, message = excluded.message, updated_at = excluded.updated_at`),
		d.ID, d.ModelGlob, d.Replacement, d.SunsetDate, d.Message, d.CreatedAt, d.UpdatedAt)
	if err != nil {
		return ModelDeprecation{}, err
	}
	return d, nil
}

// ListModelDeprecations returns all configured model deprecations, newest first.
func (s *SQLStore) ListModelDeprecations(ctx context.Context) ([]ModelDeprecation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, model_glob, COALESCE(replacement,''), COALESCE(sunset_date,''), COALESCE(message,''), created_at, updated_at
		FROM model_deprecations ORDER BY model_glob`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ModelDeprecation{}
	for rows.Next() {
		var d ModelDeprecation
		if err := rows.Scan(&d.ID, &d.ModelGlob, &d.Replacement, &d.SunsetDate, &d.Message, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeleteModelDeprecation removes a deprecation by id.
func (s *SQLStore) DeleteModelDeprecation(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM model_deprecations WHERE id = ?`), id)
	return err
}
