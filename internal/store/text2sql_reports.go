package store

import (
	"context"
	"time"
)

// Text2SQLSavedReport is a recurring question promoted to a reusable asset — a saved
// report or dashboard card — so a frequently-asked Text2SQL question becomes a
// standardized, named artifact instead of being re-typed each time.
type Text2SQLSavedReport struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Question   string `json:"question"`
	SQL        string `json:"sql"`
	SchemaName string `json:"schema_name"`
	Kind       string `json:"kind"` // report | dashboard_card
	CreatedBy  string `json:"created_by"`
	CreatedAt  string `json:"created_at"`
}

// UpsertText2SQLSavedReport stores (or replaces) a saved report.
func (s *SQLStore) UpsertText2SQLSavedReport(ctx context.Context, r Text2SQLSavedReport) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	if r.Kind == "" {
		r.Kind = "report"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_saved_reports
		(id, name, question, sql, schema_name, kind, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, question = excluded.question, sql = excluded.sql,
			schema_name = excluded.schema_name, kind = excluded.kind`),
		r.ID, r.Name, r.Question, r.SQL, r.SchemaName, r.Kind, r.CreatedBy, r.CreatedAt)
	return err
}

// ListText2SQLSavedReports returns saved reports, newest first.
func (s *SQLStore) ListText2SQLSavedReports(ctx context.Context) ([]Text2SQLSavedReport, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(question,''), COALESCE(sql,''), COALESCE(schema_name,''),
		COALESCE(kind,'report'), COALESCE(created_by,''), created_at
		FROM text2sql_saved_reports ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSavedReport{}
	for rows.Next() {
		var r Text2SQLSavedReport
		if err := rows.Scan(&r.ID, &r.Name, &r.Question, &r.SQL, &r.SchemaName, &r.Kind, &r.CreatedBy, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteText2SQLSavedReport removes a saved report.
func (s *SQLStore) DeleteText2SQLSavedReport(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_saved_reports WHERE id = ?`), id)
	return err
}
