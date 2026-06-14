package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestCollectInformationSchemaSQLite(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// A separate source DB to introspect.
	srcPath := filepath.Join(t.TempDir(), "src.db")
	src, err := sql.Open("sqlite", srcPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	for _, ddl := range []string{
		`CREATE TABLE employees (id INTEGER, name TEXT, dept TEXT)`,
		`CREATE TABLE orders (id INTEGER, amount REAL, employee_id INTEGER)`,
	} {
		if _, err := src.ExecContext(ctx, ddl); err != nil {
			t.Fatal(err)
		}
	}

	tables, cols, err := db.CollectInformationSchema(ctx, src, "sqlite", "", "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if tables != 2 || cols != 6 {
		t.Fatalf("collected tables=%d cols=%d, want 2/6", tables, cols)
	}

	cat, err := db.BuildSchemaCatalog(ctx, "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.AllowedTables) != 2 {
		t.Errorf("allowed tables = %v, want 2", cat.AllowedTables)
	}

	// Tag a column sensitive, then re-collect: existing tags must be preserved and
	// no rows re-added.
	if err := db.UpsertText2SQLColumn(ctx, Text2SQLColumn{SchemaName: "analytics", TableName: "employees", ColumnName: "name", Sensitivity: SensitivityExclude}); err != nil {
		t.Fatal(err)
	}
	t2, c2, err := db.CollectInformationSchema(ctx, src, "sqlite", "", "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if t2 != 0 || c2 != 0 {
		t.Errorf("re-collect should add nothing, added tables=%d cols=%d", t2, c2)
	}
	cat2, _ := db.BuildSchemaCatalog(ctx, "analytics")
	found := false
	for _, ex := range cat2.ExcludedColumns {
		if ex == "name" {
			found = true
		}
	}
	if !found {
		t.Error("operator sensitivity tag must survive re-collection")
	}
}
