package store

import (
	"fmt"
	"testing"
)

func TestPromptProductMetadataPagesAndTemplateState(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	for i := range 31 {
		id := fmt.Sprintf("product-%03d", i)
		if i%3 != 2 {
			if err := db.UpsertPromptTemplate(ctx, PromptTemplate{ID: id, Name: id, Category: "product", Body: "private-body", Enabled: i%3 == 0, UseCount: int64(i)}); err != nil {
				t.Fatal(err)
			}
			for range i {
				if err := db.TouchPromptTemplate(ctx, id); err != nil {
					t.Fatal(err)
				}
			}
		}
		if err := db.UpsertPromptProduct(ctx, PromptProduct{ID: id, Name: id, TemplateID: id, Category: "product", SourceFingerprint: "source-" + id, RequestCount: int64(i * 3), DistinctUsers: int64(i), CreatedAt: "2026-11-01T00:00:00Z"}); err != nil {
			t.Fatal(err)
		}
	}
	legacy, err := db.ListPromptProducts(ctx)
	if err != nil || len(legacy) != 31 {
		t.Fatal("legacy fixture mismatch", err)
	}
	byName := map[string]PromptProduct{}
	for _, p := range legacy {
		byName[p.Name] = p
	}
	for _, offset := range []int{0, 25, 50} {
		rows, total, err := db.PromptProductMetadataPage(ctx, "all", 25, offset)
		if err != nil || total != 31 || len(rows) != max(0, min(25, 31-offset)) {
			t.Fatalf("page mismatch offset=%d total=%d rows=%d err=%v", offset, total, len(rows), err)
		}
		for i, row := range rows {
			want := byName[row.Name]
			if row.Name != fmt.Sprintf("product-%03d", offset+i) || row.SourceRequests == nil || *row.SourceRequests != want.RequestCount || row.DistinctKeys == nil || *row.DistinctKeys != want.DistinctUsers {
				t.Fatal("metadata differs from the saved snapshot")
			}
			if row.TemplateState == "missing" {
				if row.UseCount != nil {
					t.Fatal("missing template must not imply zero uses")
				}
			} else if row.UseCount == nil || *row.UseCount != want.TemplateUseCount {
				t.Fatal("template expansion count mismatch")
			}
		}
	}
	for state, count := range map[string]int{"enabled": 11, "disabled": 10, "missing": 10} {
		rows, total, err := db.PromptProductMetadataPage(ctx, state, 100, 0)
		if err != nil || total != count || len(rows) != count {
			t.Fatal("template state count mismatch", state, err)
		}
		for _, row := range rows {
			if row.TemplateState != state {
				t.Fatal("template state filter mismatch")
			}
		}
	}
	if _, err := db.db.ExecContext(ctx, `UPDATE prompt_products SET source_fingerprint = NULL WHERE id = 'product-000'`); err != nil {
		t.Fatal(err)
	}
	rows, _, err := db.PromptProductMetadataPage(ctx, "all", 1, 0)
	if err != nil || len(rows) != 1 || rows[0].SourceRequests != nil || rows[0].DistinctKeys != nil {
		t.Fatal("missing source must not imply zero requests or keys", err)
	}

	for _, bounds := range [][2]int{{0, 0}, {101, 0}, {25, -1}, {25, 1000001}} {
		if _, _, err := db.PromptProductMetadataPage(ctx, "all", bounds[0], bounds[1]); err == nil {
			t.Fatal("invalid bounds accepted")
		}
	}
	if _, _, err := db.PromptProductMetadataPage(ctx, "unknown", 25, 0); err == nil {
		t.Fatal("invalid state accepted")
	}
}
