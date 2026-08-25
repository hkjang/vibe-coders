package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestCloseCancelsLifecycleContext(t *testing.T) {
	db, err := Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "lifecycle.db"),
	})
	if err != nil {
		t.Fatal(err)
	}

	lifecycle := db.LifecycleContext()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-lifecycle.Done():
	case <-time.After(time.Second):
		t.Fatal("store lifecycle context was not cancelled by Close")
	}

	if err := db.Close(); err != nil {
		t.Fatalf("second Close should be idempotent: %v", err)
	}
}
