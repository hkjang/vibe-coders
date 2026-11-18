package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSQLiteStoreFixtureConcurrentInitialization(t *testing.T) {
	var fixture sqliteStoreFixture
	const count = 8
	root := t.TempDir()
	type result struct {
		db  *SQLStore
		err error
	}
	results := make(chan result, count)
	start := make(chan struct{})
	for i := range count {
		go func() {
			<-start
			db, err := fixture.open(t.Context(), filepath.Join(root, fmt.Sprintf("schema-%d.db", i)), filepath.Join(root, fmt.Sprintf("clone-%d.db", i)))
			results <- result{db, err}
		}()
	}
	close(start)
	var opened []*SQLStore
	for range count {
		got := <-results
		if got.err != nil {
			t.Error(got.err)
		} else {
			opened = append(opened, got.db)
			t.Cleanup(func() { _ = got.db.Close() })
		}
	}
	if t.Failed() {
		return
	}
	schemas, err := filepath.Glob(filepath.Join(root, "schema-*.db"))
	if err != nil || len(schemas) != 1 {
		t.Fatal("concurrent initialization did not migrate exactly one schema")
	}
	secrets := map[string]bool{}
	revisions := map[string]bool{}
	for _, db := range opened {
		secret, err := db.apiKeyRevisionSecret(t.Context())
		if err != nil || len(secret) != 32 || secrets[string(secret)] {
			t.Fatal("unrelated fixture databases share or lack a revision secret")
		}
		secrets[string(secret)] = true
		revision, err := db.APIKeyRevision(t.Context(), APIKeyRecord{ID: "same-record"})
		if err != nil || len(revision) != 64 || revisions[revision] {
			t.Fatal("unrelated fixture databases accept the same reviewed snapshot")
		}
		revisions[revision] = true
		var integrity string
		if err := db.db.QueryRowContext(t.Context(), `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
			t.Fatal("concurrent fixture has an incomplete checkpointed schema")
		}
	}
}

func TestSQLiteStoreFixtureSurvivesSourceCleanup(t *testing.T) {
	var fixture sqliteStoreFixture
	var source string
	t.Run("initialize", func(t *testing.T) {
		source = filepath.Join(t.TempDir(), "schema.db")
		db, err := fixture.open(t.Context(), source, filepath.Join(t.TempDir(), "first.db"))
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	})
	if _, err := os.Stat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("source fixture was not cleaned up by its owner")
	}
	db, err := fixture.open(t.Context(), source, filepath.Join(t.TempDir(), "later.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(t.Context()); err != nil {
		t.Fatal("fixture depends on the original schema file")
	}
	if _, err := db.apiKeyRevisionSecret(t.Context()); err != nil {
		t.Fatal("later fixture omitted independent initialization")
	}
}

func TestSQLiteStoreFixturePreservesInitializationError(t *testing.T) {
	var fixture sqliteStoreFixture
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	root := t.TempDir()
	db, first := fixture.open(ctx, filepath.Join(root, "schema.db"), filepath.Join(root, "first.db"))
	if db != nil || !errors.Is(first, context.Canceled) {
		t.Fatal("canceled initialization did not fail closed")
	}
	db, second := fixture.open(t.Context(), filepath.Join(root, "other-schema.db"), filepath.Join(root, "second.db"))
	if db != nil || first != second {
		t.Fatal("later caller lost the initialization failure")
	}
	for _, name := range []string{"first.db", "second.db", "other-schema.db"} {
		if _, err := os.Stat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("failed initialization created a reusable %s", name)
		}
	}
}

func TestSQLiteStoreFixtureNeverOverwritesExistingFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "existing.db")
	before := []byte("preserve this file")
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := storeSQLiteFixture.open(t.Context(), filepath.Join(root, "schema.db"), path)
	if db != nil || !errors.Is(err, os.ErrExist) {
		t.Fatal("fixture attempted to replace an existing database")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(before) {
		t.Fatal("existing file was modified")
	}
}
