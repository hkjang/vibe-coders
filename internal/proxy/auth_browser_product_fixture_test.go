//go:build linux

package proxy

import (
	"fmt"
	"testing"

	"vibe-coders/internal/store"
)

func seedBrowserProductFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for i := range 31 {
		id := fmt.Sprintf("browser-product-%02d", i)
		if i%3 != 2 {
			if err := db.UpsertPromptTemplate(t.Context(), store.PromptTemplate{ID: id, Name: "제품 원본 " + id, Body: "private-product-fixture-body", Enabled: i%3 == 0}); err != nil {
				t.Fatal("product template browser fixture could not be seeded")
			}
		}
		if err := db.UpsertPromptProduct(t.Context(), store.PromptProduct{ID: id, Name: "공개 제품 " + id, TemplateID: id, SourceFingerprint: "source-" + id, Category: "product", RequestCount: int64(3 * i), DistinctUsers: int64(i), CreatedAt: "2026-11-01T00:00:00Z"}); err != nil {
			t.Fatal("product browser fixture could not be seeded")
		}
	}
}
