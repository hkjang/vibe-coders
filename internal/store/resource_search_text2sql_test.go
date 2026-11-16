package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestResourceSearchText2SQLNamesScopesAndExactDetail(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	for i := range 13 {
		team := "alpha"
		if i == 10 {
			team = "beta"
		}
		if i == 11 {
			team = ""
		}
		if i == 12 {
			team = " alpha"
		}
		sc := Text2SQLSchema{Name: fmt.Sprintf("정산 %02d", i), Team: team, SchemaText: "private context", AllowedTables: []string{"private_table"}, Enabled: i%2 == 0}
		if err := db.UpsertText2SQLSchema(t.Context(), sc); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		teams  []string
		scoped bool
		count  int
		more   bool
	}{
		{nil, false, 10, true}, {[]string{"alpha"}, true, 10, true}, {[]string{"beta"}, true, 2, false}, {nil, true, 1, false},
		{[]string{"", " alpha", "ALPHA", "' OR 1=1 --"}, true, 1, false},
	} {
		rows, more, err := db.SearchText2SQLSchemaMetadata(t.Context(), "정산", 10, tc.teams, tc.scoped)
		if err != nil || len(rows) != tc.count || more != tc.more {
			t.Fatalf("search scope/bounds: %d %v %v", len(rows), more, err)
		}
	}
	for _, q := range []string{"private context", "private_table", "alpha", "%_!", "' OR 1=1 --"} {
		rows, _, err := db.SearchText2SQLSchemaMetadata(t.Context(), q, 10, nil, false)
		if err != nil || len(rows) != 0 {
			t.Fatal("search inspected metadata outside name or interpreted SQL")
		}
	}
	for _, name := range []string{"정산/정확%_!", "ÉCOLE 한국", "정산 " + strings.Repeat("긴", 255)} {
		if err := db.UpsertText2SQLSchema(t.Context(), Text2SQLSchema{Name: name, SchemaText: "private", Enabled: false}); err != nil {
			t.Fatal(err)
		}
	}
	rows, _, err := db.SearchText2SQLSchemaMetadata(t.Context(), "%_!", 10, nil, false)
	if err != nil || len(rows) != 1 || rows[0].ID != "정산/정확%_!" {
		t.Fatal("LIKE literals lost")
	}
	rows, _, err = db.SearchText2SQLSchemaMetadata(t.Context(), "école", 10, nil, false)
	if err != nil || len(rows) != 1 || rows[0].ID != "ÉCOLE 한국" {
		t.Fatal("Unicode matching failed")
	}
	rows, _, err = db.SearchText2SQLSchemaMetadata(t.Context(), "긴긴", 10, nil, false)
	if err != nil || len(rows) != 0 {
		t.Fatal("oversized name returned")
	}
	for _, name := range []string{"정산/정확%_!", "ÉCOLE 한국", "école 한국", "정산 0", "missing", "' OR 1=1 --"} {
		rows, err := db.ListText2SQLSchemasByName(t.Context(), name)
		count := 0
		if name == "정산/정확%_!" || name == "ÉCOLE 한국" {
			count = 1
		}
		if err != nil || len(rows) != count || (count == 1 && (rows[0].Name != name || rows[0].Enabled)) {
			t.Fatal("detail changed exact name or omitted disabled row")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := db.SearchText2SQLSchemaMetadata(cancelled, "정산", 10, nil, false); err == nil {
		t.Fatal("search ignored cancellation")
	}
	if _, err := db.ListText2SQLSchemasByName(cancelled, "정산 00"); err == nil {
		t.Fatal("detail ignored cancellation")
	}
	if _, _, err := db.SearchResourceMetadata(t.Context(), "text2sql_schema", "정산", 10); err == nil {
		t.Fatal("generic unscoped API allowed schema search")
	}
}
