package store

import (
	"fmt"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

// Compare equivalent private, usable databases, including production Open and
// Close in both cases. The shared current schema is prepared before timing;
// its one-time cost remains covered by the ordinary fixture tests.
func BenchmarkSQLiteStoreFixtureInitialization(b *testing.B) {
	for _, mode := range []string{"fresh_migration", "private_copy"} {
		b.Run(mode, func(b *testing.B) {
			root := b.TempDir()
			var fixture sqliteStoreFixture
			if mode == "private_copy" {
				warm, err := fixture.open(b.Context(), filepath.Join(root, "schema.db"), filepath.Join(root, "warm.db"))
				if err != nil {
					b.Fatal(err)
				}
				if err := warm.Close(); err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				path := filepath.Join(root, fmt.Sprintf("database-%d.db", i))
				var db *SQLStore
				var err error
				if mode == "private_copy" {
					db, err = fixture.open(b.Context(), filepath.Join(root, "schema.db"), path)
				} else {
					db, err = Open(b.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
					if err == nil {
						err = db.Migrate(b.Context())
					}
				}
				if err != nil {
					if db != nil {
						_ = db.Close()
					}
					b.Fatal(err)
				}
				if err := db.Close(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
