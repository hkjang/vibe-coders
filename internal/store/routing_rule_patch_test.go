package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func routingPatchStores(t *testing.T) (*SQLStore, *SQLStore) {
	t.Helper()
	cfg := config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "rules.db")}
	var first *SQLStore
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		first = openPostgresStoreForTest(t, dsn)
		var schema string
		if err := first.db.QueryRowContext(t.Context(), `SELECT current_schema()`).Scan(&schema); err != nil {
			t.Fatal(err)
		}
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		cfg = config.DatabaseConfig{Driver: "postgres", DSN: dsn + sep + "search_path=" + schema}
	} else {
		var err error
		first, err = Open(t.Context(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := first.Migrate(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	return first, second
}

func routingPatchSeed(t *testing.T, db *SQLStore) RoutingRule {
	t.Helper()
	r := RoutingRule{ID: "patch-public", Enabled: true, Priority: 10, MatchPattern: "*",
		MaxComplexity: 100, TargetModel: "public-a", TargetProvider: "public-provider", Note: "public-note",
		CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 987, time.UTC)}
	if err := db.UpsertRoutingRule(t.Context(), r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRoutingPatchStoreNoRowAndReturning(t *testing.T) {
	db, peer := routingPatchStores(t)
	original := routingPatchSeed(t, db)
	zero, disabled, empty := 0, false, ""
	got, err := db.PatchRoutingRule(t.Context(), original.ID, RoutingRulePatch{
		Enabled: &disabled, MinComplexity: &zero, MaxComplexity: &zero, TargetProvider: &empty, Note: &empty,
	})
	want := original
	want.Enabled, want.MaxComplexity, want.TargetProvider, want.Note = false, 0, "", ""
	if err != nil || got != want {
		t.Fatal("UPDATE RETURNING did not preserve zero/false/empty or identity")
	}
	min, note := 1, "must-not-write"
	if _, err := db.PatchRoutingRule(t.Context(), original.ID, RoutingRulePatch{MinComplexity: &min, Note: &note}); !errors.Is(err, ErrRoutingRuleInvalidRange) {
		t.Fatalf("current existing invalid range: %v", err)
	}
	rows, err := peer.ListRoutingRules(t.Context())
	if err != nil || len(rows) != 1 || rows[0] != want {
		t.Fatal("zero-row invalid-range UPDATE changed the row")
	}
	if err := peer.DeleteRoutingRule(t.Context(), original.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PatchRoutingRule(t.Context(), original.ID, RoutingRulePatch{Note: &note}); !errors.Is(err, ErrRoutingRuleNotFound) {
		t.Fatalf("current missing classification: %v", err)
	}
	rows, err = peer.ListRoutingRules(t.Context())
	if err != nil || len(rows) != 0 {
		t.Fatal("missing UPDATE inserted a row")
	}
}

func TestRoutingPatchStoreConcurrentPartialUpdates(t *testing.T) {
	db, peer := routingPatchStores(t)
	for i := 0; i < 20; i++ {
		original := routingPatchSeed(t, db)
		disabled, note := false, "second-writer"
		start := make(chan struct{})
		done := make(chan error, 2)
		for index, patch := range []RoutingRulePatch{{Enabled: &disabled}, {Note: &note}} {
			current := []*SQLStore{db, peer}[index]
			go func() {
				<-start
				_, err := current.PatchRoutingRule(t.Context(), original.ID, patch)
				done <- err
			}()
		}
		close(start)
		for range 2 {
			if err := <-done; err != nil {
				t.Fatalf("independent-pool update: %v", err)
			}
		}
		rows, err := db.ListRoutingRules(t.Context())
		original.Enabled, original.Note = false, note
		if err != nil || len(rows) != 1 || rows[0] != original {
			t.Fatal("concurrent disjoint writes lost an omitted column")
		}
	}
}

func TestRoutingPatchStoreConcurrentMergedRange(t *testing.T) {
	db, peer := routingPatchStores(t)
	for i := 0; i < 20; i++ {
		original := routingPatchSeed(t, db)
		min, max := 60, 40
		start, done := make(chan struct{}), make(chan error, 2)
		for index, patch := range []RoutingRulePatch{{MinComplexity: &min}, {MaxComplexity: &max}} {
			current := []*SQLStore{db, peer}[index]
			go func() {
				<-start
				_, err := current.PatchRoutingRule(t.Context(), original.ID, patch)
				done <- err
			}()
		}
		close(start)
		success, rejected := 0, 0
		for range 2 {
			err := <-done
			if err == nil {
				success++
			} else if errors.Is(err, ErrRoutingRuleInvalidRange) {
				rejected++
			} else {
				t.Fatalf("independent-pool range update: %v", err)
			}
		}
		rows, err := db.ListRoutingRules(t.Context())
		if err != nil || len(rows) != 1 || success != 1 || rejected != 1 || rows[0].MinComplexity > rows[0].MaxComplexity {
			t.Fatal("both contradictory range writes succeeded or valid write was lost")
		}
	}
}

func TestRoutingPatchStoreSameFieldLastWriterAndCancellation(t *testing.T) {
	db, peer := routingPatchStores(t)
	original := routingPatchSeed(t, db)
	for _, note := range []string{"first", "last"} {
		if _, err := peer.PatchRoutingRule(t.Context(), original.ID, RoutingRulePatch{Note: &note}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	note := "cancelled"
	if _, err := db.PatchRoutingRule(ctx, original.ID, RoutingRulePatch{Note: &note}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled call error: %v", err)
	}
	rows, err := db.ListRoutingRules(t.Context())
	if err != nil || len(rows) != 1 || rows[0].Note != "last" {
		t.Fatal("last-writer-wins/cancelled no-write contract changed")
	}
}
