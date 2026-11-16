//go:build linux

package proxy

import (
	"fmt"
	"testing"
	"vibe-coders/internal/store"
)

func seedBrowserContextFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for i := range 31 {
		key := fmt.Sprintf("browser-context-%02d", i)
		if err := db.UpsertContextRegistry(t.Context(), store.ContextRegistryEntry{ID: key, Key: key, Name: "공개 참고자료 " + key, Content: "private-context-fixture-body", Enabled: i%2 == 0, TokenEstimate: 17 + i, UseCount: 2 * i}); err != nil {
			t.Fatal("context browser fixture could not be seeded")
		}
	}
}
