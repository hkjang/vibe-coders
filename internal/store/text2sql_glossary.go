package store

import (
	"context"
	"strings"
	"time"
)

// Text2SQLBusinessTerm maps a business vocabulary term to the tables/columns/
// conditions that express it, so users can ask in business language.
type Text2SQLBusinessTerm struct {
	ID          string `json:"id"`
	SchemaName  string `json:"schema_name"`
	Term        string `json:"term"`
	Mapping     string `json:"mapping"`
	Description string `json:"description"`
	UpdatedAt   string `json:"updated_at"`
}

// ListText2SQLBusinessTerms returns terms for a schema (schemaName=="" returns all).
func (s *SQLStore) ListText2SQLBusinessTerms(ctx context.Context, schemaName string) ([]Text2SQLBusinessTerm, error) {
	q := `SELECT id, schema_name, term, mapping, COALESCE(description,''), updated_at FROM text2sql_business_terms`
	args := []any{}
	if schemaName != "" {
		q += ` WHERE schema_name = ? OR schema_name = '*'`
		args = append(args, schemaName)
	}
	q += ` ORDER BY term`
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLBusinessTerm{}
	for rows.Next() {
		var t Text2SQLBusinessTerm
		if err := rows.Scan(&t.ID, &t.SchemaName, &t.Term, &t.Mapping, &t.Description, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLBusinessTerm(ctx context.Context, t Text2SQLBusinessTerm) error {
	if strings.TrimSpace(t.SchemaName) == "" {
		t.SchemaName = "*"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_business_terms (id, schema_name, term, mapping, description, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET schema_name = excluded.schema_name, term = excluded.term, mapping = excluded.mapping, description = excluded.description, updated_at = excluded.updated_at`),
		t.ID, t.SchemaName, t.Term, t.Mapping, t.Description, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLBusinessTerm(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_business_terms WHERE id = ?`), id)
	return err
}

// BuildGlossaryText renders the business terms for a schema into a prompt block.
func (s *SQLStore) BuildGlossaryText(ctx context.Context, schemaName string) (string, error) {
	terms, err := s.ListText2SQLBusinessTerms(ctx, schemaName)
	if err != nil || len(terms) == 0 {
		return "", err
	}
	var b strings.Builder
	for _, t := range terms {
		b.WriteString("- " + t.Term + " → " + t.Mapping)
		if t.Description != "" {
			b.WriteString(" (" + t.Description + ")")
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n"), nil
}
