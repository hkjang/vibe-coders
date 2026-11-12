package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestResourceSearchTeamScopeBoundsAndNames(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	ctx := t.Context()
	for index := range 13 {
		if err := db.UpsertAuthTeam(ctx, AuthTeam{ID: fmt.Sprintf("team-%02d", index), Name: fmt.Sprintf("정산 Search %02d", index)}); err != nil {
			t.Fatal(err)
		}
	}
	items, more, err := db.SearchAuthTeamMetadata(ctx, "search", 10, nil)
	if err != nil || !more || len(items) != 10 || items[0].ID != "team-00" || items[9].ID != "team-09" {
		t.Fatal("bounded team name navigation failed")
	}
	for _, scope := range []string{"team-12", "team-1", "TEAM-12", "", "foreign", strings.Repeat("기존", 2048)} {
		items, more, err := db.SearchAuthTeamMetadata(ctx, "정산", 10, &scope)
		want := 0
		if scope == "team-12" {
			want = 1
		}
		if err != nil || more || len(items) != want || (want == 1 && items[0].ID != scope) {
			t.Fatal("team navigation replaced, normalized or ignored exact authenticated scope")
		}
	}
	if _, _, err := db.SearchResourceMetadata(ctx, "team", "search", 10); err == nil {
		t.Fatal("unscoped generic metadata API accepted team kind")
	}
	for _, query := range []string{"team-12", "%_", "' OR 1=1 --"} {
		items, _, err := db.SearchAuthTeamMetadata(ctx, query, 10, nil)
		if err != nil || len(items) != 0 {
			t.Fatal("team navigation searched identifiers or treated query as syntax")
		}
	}
	for index, row := range []AuthTeam{
		{ID: "literal", Name: "100%_! 정산"},
		{ID: strings.Repeat("i", 513), Name: "oversized identifier"},
		{ID: "long-title", Name: "oversized " + strings.Repeat("가", 256)},
		{ID: strings.Repeat("😀", 512), Name: "unicode boundary"},
	} {
		if err := db.UpsertAuthTeam(ctx, row); err != nil {
			t.Fatalf("fixture %d failed: %v", index, err)
		}
	}
	for _, tc := range []struct{ query, id string }{{"%_!", "literal"}, {"oversized", ""}, {"unicode boundary", strings.Repeat("😀", 512)}} {
		items, _, err := db.SearchAuthTeamMetadata(ctx, tc.query, 10, nil)
		if err != nil || (tc.id == "" && len(items) != 0) || (tc.id != "" && (len(items) != 1 || items[0].ID != tc.id)) {
			t.Fatal("metadata navigation byte/character bounds or literal search failed")
		}
	}
	if db.dialect == "sqlite" {
		if err := db.UpsertAuthTeam(ctx, AuthTeam{ID: "nul", Name: "oversized\x00" + strings.Repeat("x", 64<<10)}); err != nil {
			t.Fatal(err)
		}
		items, _, err := db.SearchAuthTeamMetadata(ctx, "oversized", 10, nil)
		if err != nil || len(items) != 0 {
			t.Fatal("embedded NUL bypassed byte bounds")
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := db.SearchAuthTeamMetadata(cancelled, "정산", 10, nil); err == nil {
		t.Fatal("cancelled search queried storage")
	}
}

func TestResourceSearchUnicodeLowercase(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for index, name := range []string{"ÄPFEL 분석", "ΣΥΝΟΛΟ 분석", "ПРОЕКТ 분석"} {
		id := fmt.Sprintf("unicode-%d", index)
		if err := db.UpsertWorkflow(t.Context(), Workflow{ID: id, Name: name}); err != nil {
			t.Fatal(err)
		}
		if err := db.UpsertAuthTeam(t.Context(), AuthTeam{ID: id, Name: name}); err != nil {
			t.Fatal(err)
		}
		for _, query := range []string{name, strings.ToLower(name)} {
			rows, _, err := db.SearchResourceMetadata(t.Context(), "workflow", query, 10)
			if err != nil || len(rows) != 1 || rows[0].ID != id {
				t.Fatal("existing name search lost Unicode case match")
			}
			rows, _, err = db.SearchAuthTeamMetadata(t.Context(), query, 10, &id)
			if err != nil || len(rows) != 1 || rows[0].ID != id {
				t.Fatal("scoped team search lost Unicode case match")
			}
		}
	}
}
