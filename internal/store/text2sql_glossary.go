package store

import (
	"context"
	"sort"
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

// Text2SQLGlossaryConflict flags a business term that resolves ambiguously: the same
// term (case-insensitive) is defined more than once with differing mappings, which
// makes generation non-deterministic. Kind is "duplicate_mapping" (same term, multiple
// distinct mappings) or "shadowed" (a schema-specific term also defined globally).
type Text2SQLGlossaryConflict struct {
	Term     string   `json:"term"`
	Kind     string   `json:"kind"`
	Mappings []string `json:"mappings"`
	Scopes   []string `json:"scopes"`
}

// DetectGlossaryConflicts finds terms applicable to a schema (its own + global "*")
// that are defined more than once with differing mappings, or shadowed across scopes.
func (s *SQLStore) DetectGlossaryConflicts(ctx context.Context, schemaName string) ([]Text2SQLGlossaryConflict, error) {
	terms, err := s.ListText2SQLBusinessTerms(ctx, schemaName)
	if err != nil {
		return nil, err
	}
	type agg struct {
		mappings map[string]bool
		scopes   map[string]bool
	}
	byTerm := map[string]*agg{}
	order := []string{}
	for _, t := range terms {
		key := strings.ToLower(strings.TrimSpace(t.Term))
		a := byTerm[key]
		if a == nil {
			a = &agg{mappings: map[string]bool{}, scopes: map[string]bool{}}
			byTerm[key] = a
			order = append(order, key)
		}
		a.mappings[strings.TrimSpace(t.Mapping)] = true
		a.scopes[t.SchemaName] = true
	}
	out := []Text2SQLGlossaryConflict{}
	for _, key := range order {
		a := byTerm[key]
		if len(a.mappings) <= 1 {
			continue // single mapping (even across scopes) → not a conflict
		}
		kind := "duplicate_mapping"
		if a.scopes["*"] && len(a.scopes) > 1 {
			kind = "shadowed" // schema-specific term competes with a global one
		}
		out = append(out, Text2SQLGlossaryConflict{
			Term: key, Kind: kind, Mappings: sortedKeys(a.mappings), Scopes: sortedKeys(a.scopes),
		})
	}
	return out, nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
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
