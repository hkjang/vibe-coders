package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestResourceSearchAPIKeyNamesScopeAndCatalogParity(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for i := range 13 {
		team := "alpha"
		if i == 11 {
			team = "beta"
		}
		if i == 12 {
			team = ""
		}
		if err := db.UpsertAPIKey(t.Context(), APIKeyRecord{ID: fmt.Sprintf("key_%02d", i), Name: fmt.Sprintf("정산 Search %02d", i), Team: team, Owner: "excluded-owner", KeyHash: fmt.Sprintf("excluded-hash-%d", i), Scopes: []string{"excluded-scope"}}); err != nil {
			t.Fatal(err)
		}
	}
	all, err := db.ListAPIKeys(t.Context())
	if err != nil || len(all) != 13 {
		t.Fatal("existing catalog changed")
	}
	for _, tc := range []struct {
		scope *string
		count int
		more  bool
	}{
		{nil, 10, true}, {ptrAPIKeyScope("alpha"), 10, true}, {ptrAPIKeyScope("beta"), 1, false}, {ptrAPIKeyScope(""), 1, false}, {ptrAPIKeyScope("ALPHA"), 0, false}, {ptrAPIKeyScope("alp"), 0, false},
	} {
		items, more, err := db.SearchAPIKeyMetadata(t.Context(), "search", 10, tc.scope)
		if err != nil || len(items) != tc.count || more != tc.more {
			t.Fatal("scope or limit mismatch")
		}
		for i, item := range items {
			if i > 0 && items[i-1].Title >= item.Title {
				t.Fatal("unstable search order")
			}
			keys, err := db.ListAPIKeysByID(t.Context(), item.ID, tc.scope)
			if err != nil || len(keys) != 1 || keys[0].Name != item.Title {
				t.Fatal("search and exact detail disagree")
			}
			for _, key := range all {
				if key.ID == item.ID && !reflect.DeepEqual(key, keys[0]) {
					t.Fatal("public revision projection changed")
				}
			}
			body, _ := json.Marshal(keys)
			if strings.Contains(string(body), "excluded-hash") || strings.Contains(string(body), "key_hash") {
				t.Fatal("detail exposed key hash")
			}
		}
	}
	for _, id := range []string{"key_11", "key_12", "missing", "KEY_00", "key_0"} {
		keys, err := db.ListAPIKeysByID(t.Context(), id, ptrAPIKeyScope("alpha"))
		if err != nil || len(keys) != 0 {
			t.Fatal("exact scoped detail broadened")
		}
	}
	for _, query := range []string{"key_00", "excluded-owner", "excluded-hash", "excluded-scope", "' OR 1=1 --"} {
		items, _, err := db.SearchAPIKeyMetadata(t.Context(), query, 10, nil)
		if err != nil || len(items) != 0 {
			t.Fatal("search used non-name fields or SQL syntax")
		}
	}
	if _, _, err := db.SearchResourceMetadata(t.Context(), "api_key", "정산", 10); err == nil {
		t.Fatal("generic unscoped API accepted key kind")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := db.SearchAPIKeyMetadata(ctx, "정산", 10, nil); err == nil {
		t.Fatal("cancelled search succeeded")
	}
}
func ptrAPIKeyScope(value string) *string { return &value }

func TestResourceSearchAPIKeyUnicodeLiteralAndBounds(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	for i, row := range []APIKeyRecord{{ID: "literal", Name: "100%_! 정산"}, {ID: "unicode", Name: "ÄPFEL ΣΥΝΟΛΟ 분석"}, {ID: strings.Repeat("x", 513), Name: "oversized id"}, {ID: "long-name", Name: "oversized " + strings.Repeat("가", 256)}} {
		row.KeyHash = fmt.Sprintf("bounds-%d", i)
		if err := db.UpsertAPIKey(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ q, id string }{{"%_!", "literal"}, {"äpfel συνολο", "unicode"}, {"oversized", ""}} {
		items, _, err := db.SearchAPIKeyMetadata(t.Context(), tc.q, 10, nil)
		if err != nil || (tc.id == "" && len(items) != 0) || (tc.id != "" && (len(items) != 1 || items[0].ID != tc.id)) {
			t.Fatal("literal/Unicode/bounds mismatch")
		}
	}
}
