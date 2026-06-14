package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// Column sensitivity levels.
const (
	SensitivityNormal  = "normal"  // fully usable
	SensitivityMask    = "mask"    // usable, but result values are masked
	SensitivityExclude = "exclude" // hidden from the LLM and rejected if referenced
)

// Text2SQLTable is one table in a schema registry (replaces free-text schema blobs).
type Text2SQLTable struct {
	SchemaName  string `json:"schema_name"`
	TableName   string `json:"table_name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	UpdatedAt   string `json:"updated_at"`
}

// Text2SQLColumn is one column with a business description and sensitivity tag.
type Text2SQLColumn struct {
	SchemaName  string `json:"schema_name"`
	TableName   string `json:"table_name"`
	ColumnName  string `json:"column_name"`
	DataType    string `json:"data_type"`
	Description string `json:"description"`
	Sensitivity string `json:"sensitivity"`
	UpdatedAt   string `json:"updated_at"`
}

// SchemaCatalog is the resolved registry for a schema: the prompt context rendered
// from tables/columns (excluding sensitivity=exclude columns), the enabled-table
// allowlist, and the set of excluded columns that must not appear in generated SQL.
type SchemaCatalog struct {
	ContextText     string   `json:"context_text"`
	AllowedTables   []string `json:"allowed_tables"`
	ExcludedColumns []string `json:"excluded_columns"`
	HasTables       bool     `json:"has_tables"`
}

func (s *SQLStore) ListText2SQLTables(ctx context.Context, schemaName string) ([]Text2SQLTable, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT schema_name, table_name, COALESCE(description,''), enabled, updated_at
		FROM text2sql_tables WHERE schema_name = ? ORDER BY table_name`), schemaName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLTable{}
	for rows.Next() {
		var t Text2SQLTable
		var enabled int
		if err := rows.Scan(&t.SchemaName, &t.TableName, &t.Description, &enabled, &t.UpdatedAt); err != nil {
			return nil, err
		}
		t.Enabled = enabled == 1
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLTable(ctx context.Context, t Text2SQLTable) error {
	enabled := 1
	if !t.Enabled {
		enabled = 0
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_tables (schema_name, table_name, description, enabled, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(schema_name, table_name) DO UPDATE SET description = excluded.description, enabled = excluded.enabled, updated_at = excluded.updated_at`),
		t.SchemaName, t.TableName, t.Description, enabled, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLTable(ctx context.Context, schemaName, tableName string) error {
	if _, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_columns WHERE schema_name = ? AND table_name = ?`), schemaName, tableName); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_tables WHERE schema_name = ? AND table_name = ?`), schemaName, tableName)
	return err
}

func (s *SQLStore) ListText2SQLColumns(ctx context.Context, schemaName string) ([]Text2SQLColumn, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT schema_name, table_name, column_name, COALESCE(data_type,''), COALESCE(description,''), sensitivity, updated_at
		FROM text2sql_columns WHERE schema_name = ? ORDER BY table_name, column_name`), schemaName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLColumn{}
	for rows.Next() {
		var c Text2SQLColumn
		if err := rows.Scan(&c.SchemaName, &c.TableName, &c.ColumnName, &c.DataType, &c.Description, &c.Sensitivity, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLColumn(ctx context.Context, c Text2SQLColumn) error {
	if c.Sensitivity == "" {
		c.Sensitivity = SensitivityNormal
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_columns (schema_name, table_name, column_name, data_type, description, sensitivity, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(schema_name, table_name, column_name) DO UPDATE SET data_type = excluded.data_type, description = excluded.description, sensitivity = excluded.sensitivity, updated_at = excluded.updated_at`),
		c.SchemaName, c.TableName, c.ColumnName, c.DataType, c.Description, c.Sensitivity, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLColumn(ctx context.Context, schemaName, tableName, columnName string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_columns WHERE schema_name = ? AND table_name = ? AND column_name = ?`), schemaName, tableName, columnName)
	return err
}

// CollectInformationSchema reads the table/column layout from a source database
// (src) and populates the registry under registrySchema. Existing sensitivity tags
// and descriptions are preserved (it only upserts structure). Supports PostgreSQL
// (information_schema) and SQLite (sqlite_master + PRAGMA). Returns counts.
func (s *SQLStore) CollectInformationSchema(ctx context.Context, src *sql.DB, driver, dbSchema, registrySchema string) (int, int, error) {
	driver = strings.ToLower(strings.TrimSpace(driver))
	type col struct{ table, name, typ string }
	var cols []col

	if driver == "sqlite" {
		rows, err := src.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
		if err != nil {
			return 0, 0, err
		}
		var tables []string
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err != nil {
				rows.Close()
				return 0, 0, err
			}
			tables = append(tables, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, 0, err
		}
		for _, t := range tables {
			cr, err := src.QueryContext(ctx, `SELECT name, type FROM pragma_table_info(?)`, t)
			if err != nil {
				return 0, 0, err
			}
			for cr.Next() {
				var name, typ string
				if err := cr.Scan(&name, &typ); err != nil {
					cr.Close()
					return 0, 0, err
				}
				cols = append(cols, col{t, name, typ})
			}
			cr.Close()
		}
	} else { // postgres / pgx
		if dbSchema == "" {
			dbSchema = "public"
		}
		rows, err := src.QueryContext(ctx, `SELECT table_name, column_name, data_type
			FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, dbSchema)
		if err != nil {
			return 0, 0, err
		}
		for rows.Next() {
			var c col
			if err := rows.Scan(&c.table, &c.name, &c.typ); err != nil {
				rows.Close()
				return 0, 0, err
			}
			cols = append(cols, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, 0, err
		}
	}

	// Ensure a schema row exists so the registry is resolvable by name.
	if _, found, _ := s.ResolveText2SQLSchema(ctx, registrySchema, ""); !found {
		_ = s.UpsertText2SQLSchema(ctx, Text2SQLSchema{Name: registrySchema, SchemaText: "(auto-collected)", Enabled: true})
	}
	// Preserve operator-set descriptions/sensitivity: only add tables/columns that
	// aren't already registered.
	existingTables, _ := s.ListText2SQLTables(ctx, registrySchema)
	haveTable := map[string]bool{}
	for _, t := range existingTables {
		haveTable[t.TableName] = true
	}
	existingCols, _ := s.ListText2SQLColumns(ctx, registrySchema)
	haveCol := map[string]bool{}
	for _, c := range existingCols {
		haveCol[c.TableName+"\x00"+c.ColumnName] = true
	}

	addedTables, addedCols := 0, 0
	tableSeen := map[string]bool{}
	for _, c := range cols {
		if !tableSeen[c.table] {
			tableSeen[c.table] = true
			if !haveTable[c.table] {
				if err := s.UpsertText2SQLTable(ctx, Text2SQLTable{SchemaName: registrySchema, TableName: c.table, Enabled: true}); err != nil {
					return addedTables, addedCols, err
				}
				addedTables++
			}
		}
		if !haveCol[c.table+"\x00"+c.name] {
			if err := s.UpsertText2SQLColumn(ctx, Text2SQLColumn{SchemaName: registrySchema, TableName: c.table, ColumnName: c.name, DataType: c.typ, Sensitivity: SensitivityNormal}); err != nil {
				return addedTables, addedCols, err
			}
			addedCols++
		}
	}
	return addedTables, addedCols, nil
}

// BuildSchemaCatalog renders the registry for a schema into prompt context +
// permission metadata. Excluded (sensitive) columns are omitted from the context
// and returned separately so the validator can reject SQL that references them.
func (s *SQLStore) BuildSchemaCatalog(ctx context.Context, schemaName string) (SchemaCatalog, error) {
	cat := SchemaCatalog{AllowedTables: []string{}, ExcludedColumns: []string{}}
	tables, err := s.ListText2SQLTables(ctx, schemaName)
	if err != nil {
		return cat, err
	}
	if len(tables) == 0 {
		return cat, nil
	}
	cols, err := s.ListText2SQLColumns(ctx, schemaName)
	if err != nil {
		return cat, err
	}
	colsByTable := map[string][]Text2SQLColumn{}
	for _, c := range cols {
		colsByTable[c.TableName] = append(colsByTable[c.TableName], c)
	}

	cat.HasTables = true
	var b strings.Builder
	for _, t := range tables {
		if !t.Enabled {
			continue
		}
		cat.AllowedTables = append(cat.AllowedTables, strings.ToLower(t.TableName))
		b.WriteString("- " + t.TableName)
		if t.Description != "" {
			b.WriteString(" — " + t.Description)
		}
		b.WriteString("\n")
		for _, c := range colsByTable[t.TableName] {
			if c.Sensitivity == SensitivityExclude {
				cat.ExcludedColumns = append(cat.ExcludedColumns, strings.ToLower(c.ColumnName))
				continue // never expose excluded columns to the model
			}
			b.WriteString("    - " + c.ColumnName)
			if c.DataType != "" {
				b.WriteString(" (" + c.DataType + ")")
			}
			if c.Description != "" {
				b.WriteString(": " + c.Description)
			}
			if c.Sensitivity == SensitivityMask {
				b.WriteString(" [민감: 결과 마스킹됨]")
			}
			b.WriteString("\n")
		}
	}
	cat.ContextText = strings.TrimRight(b.String(), "\n")
	return cat, nil
}
