package store

import (
	"context"
	"strings"
	"testing"
)

func TestBuildSchemaCatalog(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Empty registry → no tables.
	if cat, err := db.BuildSchemaCatalog(ctx, "analytics"); err != nil || cat.HasTables {
		t.Fatalf("empty catalog should have no tables: %+v err=%v", cat, err)
	}

	if err := db.UpsertText2SQLTable(ctx, Text2SQLTable{SchemaName: "analytics", TableName: "employees", Description: "직원", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertText2SQLTable(ctx, Text2SQLTable{SchemaName: "analytics", TableName: "archived", Description: "보관", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	cols := []Text2SQLColumn{
		{SchemaName: "analytics", TableName: "employees", ColumnName: "name", DataType: "text", Description: "이름", Sensitivity: SensitivityNormal},
		{SchemaName: "analytics", TableName: "employees", ColumnName: "salary", DataType: "int", Description: "급여", Sensitivity: SensitivityMask},
		{SchemaName: "analytics", TableName: "employees", ColumnName: "ssn", DataType: "text", Description: "주민번호", Sensitivity: SensitivityExclude},
	}
	for _, c := range cols {
		if err := db.UpsertText2SQLColumn(ctx, c); err != nil {
			t.Fatal(err)
		}
	}

	cat, err := db.BuildSchemaCatalog(ctx, "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if !cat.HasTables {
		t.Fatal("expected HasTables")
	}
	// Disabled table excluded from allowlist.
	if len(cat.AllowedTables) != 1 || cat.AllowedTables[0] != "employees" {
		t.Errorf("allowed tables = %v, want [employees]", cat.AllowedTables)
	}
	// Excluded (sensitive) column reported and NOT in the rendered context.
	if len(cat.ExcludedColumns) != 1 || cat.ExcludedColumns[0] != "ssn" {
		t.Errorf("excluded columns = %v, want [ssn]", cat.ExcludedColumns)
	}
	if strings.Contains(cat.ContextText, "ssn") {
		t.Error("excluded column ssn must not appear in the prompt context")
	}
	if !strings.Contains(cat.ContextText, "name") || !strings.Contains(cat.ContextText, "salary") {
		t.Errorf("context should list normal/mask columns: %q", cat.ContextText)
	}
	if !strings.Contains(cat.ContextText, "마스킹") {
		t.Error("mask column should be annotated in context")
	}
	if strings.Contains(cat.ContextText, "archived") {
		t.Error("disabled table must not appear in context")
	}

	// Delete cascades to columns.
	if err := db.DeleteText2SQLTable(ctx, "analytics", "employees"); err != nil {
		t.Fatal(err)
	}
	if remaining, _ := db.ListText2SQLColumns(ctx, "analytics"); len(remaining) != 0 {
		t.Errorf("deleting a table should remove its columns, got %d", len(remaining))
	}
}
