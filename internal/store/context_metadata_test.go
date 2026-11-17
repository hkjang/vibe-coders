package store

import (
	"fmt"
	"testing"
	"time"
)

func TestContextMetadataPagesAndLegacyParity(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	for i := range 31 {
		key := fmt.Sprintf("ctx-%03d", i)
		if err := db.UpsertContextRegistry(ctx, ContextRegistryEntry{ID: key, Key: key, Name: "참고자료 " + key, Content: "private-body", Enabled: i%2 == 0, TokenEstimate: i, UseCount: i, LastUsedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	legacy, err := db.ListContextRegistry(ctx)
	if err != nil || len(legacy) != 31 {
		t.Fatal("legacy fixture mismatch")
	}
	for _, offset := range []int{0, 25, 50} {
		rows, total, err := db.ContextMetadataPage(ctx, nil, 25, offset)
		if err != nil || total != len(legacy) || len(rows) != max(0, min(25, len(legacy)-offset)) {
			t.Fatalf("page mismatch offset=%d total=%d rows=%d err=%v", offset, total, len(rows), err)
		}
		for i, row := range rows {
			want := legacy[offset+i]
			if row.Key != want.Key || row.Name != want.Name || row.Enabled != want.Enabled || row.UseCount != want.UseCount || row.TokenEstimate != want.TokenEstimate {
				t.Fatal("metadata diverged from registry")
			}
		}
	}
	for _, enabled := range []bool{true, false} {
		rows, total, err := db.ContextMetadataPage(ctx, &enabled, 100, 0)
		expected := 15
		if enabled {
			expected++
		}
		if err != nil || len(rows) != expected || total != expected {
			t.Fatal("state filter mismatch", err)
		}
		for _, row := range rows {
			if row.Enabled != enabled {
				t.Fatal("state filter leaked")
			}
		}
	}
	for _, bounds := range [][2]int{{0, 0}, {101, 0}, {25, -1}, {25, 1000001}} {
		if _, _, err := db.ContextMetadataPage(ctx, nil, bounds[0], bounds[1]); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
}
