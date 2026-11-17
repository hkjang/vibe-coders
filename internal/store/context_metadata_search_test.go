package store

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestContextMetadataSearchAndSort(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	entries := []ContextRegistryEntry{
		{ID: "a", Key: "a", Name: "팀 안내", Content: "body-only-marker", Enabled: true, UseCount: 7, TokenEstimate: 10},
		{ID: "b", Key: "b", Name: "팀 안내", Enabled: true, UseCount: 7, TokenEstimate: 20},
		{ID: "c", Key: "c", Name: "팀 서식", Enabled: false, UseCount: 2, TokenEstimate: 30},
		{ID: "d", Key: "d", Name: "팀 과거", Enabled: true, UseCount: -1, TokenEstimate: -1},
		{ID: "literal", Key: "literal%_!", Name: "별도 표기", UseCount: 1, TokenEstimate: 1},
		{ID: "unicode", Key: "unicode", Name: "Été 자료", UseCount: 1, TokenEstimate: 1},
	}
	for _, entry := range entries {
		if err := db.UpsertContextRegistry(t.Context(), entry); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		search string
		keys   []string
	}{
		{"팀", []string{"a", "b", "c", "d"}}, {"%_!", []string{"literal%_!"}}, {"ÉTÉ", []string{"unicode"}}, {"LITERAL", []string{"literal%_!"}}, {"body-only-marker", []string{}}, {"%' OR 1=1--", []string{}},
	} {
		rows, total, err := db.SearchContextMetadataPage(t.Context(), ContextMetadataQuery{Search: tc.search, Limit: 25})
		keys := []string{}
		for _, row := range rows {
			keys = append(keys, row.Key)
		}
		if err != nil || total != len(tc.keys) || !reflect.DeepEqual(keys, tc.keys) {
			t.Fatalf("search projection mismatch: count=%d keys=%v err=%v", total, keys, err)
		}
	}
	enabled := true
	for _, tc := range []struct {
		sort string
		keys []string
	}{
		{"use_count:desc", []string{"a", "b", "d"}}, {"use_count:asc", []string{"a", "b", "d"}},
		{"use_count:desc,token_estimate:desc", []string{"b", "a", "d"}}, {"token_estimate:asc,name:desc", []string{"a", "b", "d"}}, {"key:desc", []string{"d", "b", "a"}},
	} {
		keys := []string{}
		for _, offset := range []int{0, 2} {
			rows, total, err := db.SearchContextMetadataPage(t.Context(), ContextMetadataQuery{Search: "팀", Enabled: &enabled, Sort: tc.sort, Limit: 2, Offset: offset})
			if err != nil || total != 3 {
				t.Fatal("filtered page count mismatch", err, total)
			}
			for _, row := range rows {
				keys = append(keys, row.Key)
				if !row.Enabled {
					t.Fatal("state filter ignored")
				}
			}
		}
		if !reflect.DeepEqual(keys, tc.keys) {
			t.Fatalf("sort mismatch %s: %v", tc.sort, keys)
		}
	}
}

func TestContextMetadataSearchRejectsInvalidInput(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	for _, sort := range []string{"name", "name:up", "name:asc,name:desc", "key:asc,name:asc,enabled:asc,use_count:desc", "name:asc,", "name:asc;DROP TABLE context_registry", "content:asc", " NAME:asc"} {
		if _, _, err := db.SearchContextMetadataPage(t.Context(), ContextMetadataQuery{Sort: sort, Limit: 25}); !errors.Is(err, ErrInvalidContextMetadataQuery) {
			t.Fatal("invalid sort accepted", sort)
		}
	}
	for _, search := range []string{strings.Repeat("한", 201), "line\nbreak", "\xff", " padded"} {
		if _, _, err := db.SearchContextMetadataPage(t.Context(), ContextMetadataQuery{Search: search, Limit: 25}); !errors.Is(err, ErrInvalidContextMetadataQuery) {
			t.Fatal("invalid search accepted")
		}
	}
	if _, _, err := db.SearchContextMetadataPage(t.Context(), ContextMetadataQuery{Search: strings.Repeat("😀", 200), Limit: 25}); err != nil {
		t.Fatal("valid Unicode boundary rejected", err)
	}
}
