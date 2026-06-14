package store

import (
	"context"
	"strings"
	"time"
)

// Text2SQLSchema is a named, admin-managed schema catalog entry: the schema/context
// text injected into the SQL-generation prompt plus the table allowlist used to
// validate generated SQL. A blank Team makes it global; otherwise it is scoped to
// that team. IsDefault marks the schema picked when a request names none.
type Text2SQLSchema struct {
	Team          string   `json:"team"`
	Name          string   `json:"name"`
	Dialect       string   `json:"dialect"`
	SchemaText    string   `json:"schema_text"`
	AllowedTables []string `json:"allowed_tables"`
	IsDefault     bool     `json:"is_default"`
	Enabled       bool     `json:"enabled"`
	UpdatedAt     string   `json:"updated_at"`
}

func (s *SQLStore) ListText2SQLSchemas(ctx context.Context) ([]Text2SQLSchema, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, COALESCE(team,''), COALESCE(dialect,''), schema_text, COALESCE(allowed_tables,''), is_default, enabled, updated_at
		FROM text2sql_schemas ORDER BY team, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSchema{}
	for rows.Next() {
		var sc Text2SQLSchema
		var allowed string
		var isDefault, enabled int
		if err := rows.Scan(&sc.Name, &sc.Team, &sc.Dialect, &sc.SchemaText, &allowed, &isDefault, &enabled, &sc.UpdatedAt); err != nil {
			return nil, err
		}
		sc.AllowedTables = splitCSV(allowed)
		sc.IsDefault = isDefault == 1
		sc.Enabled = enabled == 1
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLSchema(ctx context.Context, sc Text2SQLSchema) error {
	enabled, isDefault := 1, 0
	if !sc.Enabled {
		enabled = 0
	}
	if sc.IsDefault {
		isDefault = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_schemas
		(name, team, dialect, schema_text, allowed_tables, is_default, enabled, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET team = excluded.team, dialect = excluded.dialect, schema_text = excluded.schema_text,
			allowed_tables = excluded.allowed_tables, is_default = excluded.is_default, enabled = excluded.enabled, updated_at = excluded.updated_at`),
		sc.Name, sc.Team, sc.Dialect, sc.SchemaText, strings.Join(sc.AllowedTables, ","), isDefault, enabled, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLSchema(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_schemas WHERE name = ?`), name)
	return err
}

// ResolveText2SQLSchema picks the schema for a request. Preference order:
//  1. an explicitly named schema the team may use (its team matches or is global),
//  2. the team's default schema, then a global default,
//  3. (caller falls back to inline config when this returns found=false).
func (s *SQLStore) ResolveText2SQLSchema(ctx context.Context, name, team string) (Text2SQLSchema, bool, error) {
	schemas, err := s.ListText2SQLSchemas(ctx)
	if err != nil {
		return Text2SQLSchema{}, false, err
	}
	accessible := func(sc Text2SQLSchema) bool {
		return sc.Enabled && (sc.Team == "" || sc.Team == team)
	}
	name = strings.TrimSpace(name)
	if name != "" {
		for _, sc := range schemas {
			if sc.Name == name && accessible(sc) {
				return sc, true, nil
			}
		}
		return Text2SQLSchema{}, false, nil // named but not accessible → no fallback
	}
	// team default, then global default, then any accessible.
	var globalDefault, anyAccessible *Text2SQLSchema
	for i := range schemas {
		sc := schemas[i]
		if !accessible(sc) {
			continue
		}
		if sc.IsDefault && sc.Team == team && team != "" {
			return sc, true, nil
		}
		if sc.IsDefault && sc.Team == "" && globalDefault == nil {
			globalDefault = &schemas[i]
		}
		if anyAccessible == nil {
			anyAccessible = &schemas[i]
		}
	}
	if globalDefault != nil {
		return *globalDefault, true, nil
	}
	if anyAccessible != nil {
		return *anyAccessible, true, nil
	}
	return Text2SQLSchema{}, false, nil
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
