package store

import (
	"context"
	"strings"
	"time"
)

// Text2SQLGoldenQuery is a verified natural-language question paired with its
// expected SQL. They serve two purposes: few-shot examples that improve generation,
// and a regression set replayed when models/prompts change.
type Text2SQLGoldenQuery struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Question    string   `json:"question"`
	ExpectedSQL string   `json:"expected_sql"`
	SchemaName  string   `json:"schema_name"`
	Tags        []string `json:"tags"`
	Enabled     bool     `json:"enabled"`
	Source      string   `json:"source"` // manual | auto (auto = unpromoted candidate)
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

func (s *SQLStore) ListText2SQLGoldenQueries(ctx context.Context, onlyEnabled bool) ([]Text2SQLGoldenQuery, error) {
	where := ""
	if onlyEnabled {
		where = "WHERE enabled = 1"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, question, expected_sql, COALESCE(schema_name,''), COALESCE(tags,''), enabled, COALESCE(source,'manual'), created_at, updated_at
		FROM text2sql_golden_queries `+where+` ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLGoldenQuery{}
	for rows.Next() {
		var g Text2SQLGoldenQuery
		var tags string
		var enabled int
		if err := rows.Scan(&g.ID, &g.Name, &g.Question, &g.ExpectedSQL, &g.SchemaName, &tags, &enabled, &g.Source, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		g.Tags = splitCSV(tags)
		g.Enabled = enabled == 1
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLGoldenQuery(ctx context.Context, g Text2SQLGoldenQuery) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if g.CreatedAt == "" {
		g.CreatedAt = now
	}
	enabled := 1
	if !g.Enabled {
		enabled = 0
	}
	if g.Source == "" {
		g.Source = "manual"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_golden_queries
		(id, name, question, expected_sql, schema_name, tags, enabled, source, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, question = excluded.question, expected_sql = excluded.expected_sql,
			schema_name = excluded.schema_name, tags = excluded.tags, enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at`),
		g.ID, g.Name, g.Question, g.ExpectedSQL, g.SchemaName, strings.Join(g.Tags, ","), enabled, g.Source, g.CreatedAt, now)
	return err
}

// AddText2SQLGoldenCandidate records a successful (question, SQL) as a disabled
// auto-candidate for later admin promotion. It de-duplicates on the exact question
// so repeated queries don't flood the candidate list.
func (s *SQLStore) AddText2SQLGoldenCandidate(ctx context.Context, id, question, sql, schemaName string) error {
	var existing int
	if err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(1) FROM text2sql_golden_queries WHERE question = ?`), question).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	name := question
	if len(name) > 60 {
		name = name[:60]
	}
	return s.UpsertText2SQLGoldenQuery(ctx, Text2SQLGoldenQuery{
		ID: id, Name: "(auto) " + name, Question: question, ExpectedSQL: sql,
		SchemaName: schemaName, Enabled: false, Source: "auto",
	})
}

func (s *SQLStore) DeleteText2SQLGoldenQuery(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_golden_queries WHERE id = ?`), id)
	return err
}
