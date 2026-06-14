package store

import (
	"context"
	"testing"
)

func TestResolveText2SQLSchema(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	must := func(sc Text2SQLSchema) {
		if err := db.UpsertText2SQLSchema(ctx, sc); err != nil {
			t.Fatal(err)
		}
	}
	must(Text2SQLSchema{Name: "global", Dialect: "PostgreSQL", SchemaText: "t(x)", IsDefault: true, Enabled: true})
	must(Text2SQLSchema{Name: "platform", Team: "platform", SchemaText: "p(x)", AllowedTables: []string{"p"}, IsDefault: true, Enabled: true})
	must(Text2SQLSchema{Name: "secret", Team: "security", SchemaText: "s(x)", Enabled: true})
	must(Text2SQLSchema{Name: "disabled", SchemaText: "d(x)", Enabled: false})

	// Named + accessible (global) → returned.
	if sc, ok, _ := db.ResolveText2SQLSchema(ctx, "global", "platform"); !ok || sc.Name != "global" {
		t.Errorf("named global lookup failed: %+v ok=%v", sc, ok)
	}
	// Named but team-scoped to another team → not accessible, no fallback.
	if _, ok, _ := db.ResolveText2SQLSchema(ctx, "secret", "platform"); ok {
		t.Error("platform should not access the security-team schema")
	}
	// No name + team has its own default → team default wins over global.
	if sc, ok, _ := db.ResolveText2SQLSchema(ctx, "", "platform"); !ok || sc.Name != "platform" {
		t.Errorf("team default should win: %+v ok=%v", sc, ok)
	}
	// No name + team without a schema → global default.
	if sc, ok, _ := db.ResolveText2SQLSchema(ctx, "", "marketing"); !ok || sc.Name != "global" {
		t.Errorf("global default expected: %+v ok=%v", sc, ok)
	}
	// Disabled schema never resolves by name.
	if _, ok, _ := db.ResolveText2SQLSchema(ctx, "disabled", ""); ok {
		t.Error("disabled schema should not resolve")
	}
}
