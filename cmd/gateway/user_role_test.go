package main

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestSetUserRoleCommand(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "gateway.db")
	db, err := store.Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateAuthUser(context.Background(), store.AuthUser{ID: "usr_1", Email: "owner@example.com", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	t.Setenv("DB_DRIVER", "sqlite")
	t.Setenv("DB_DSN", dsn)

	var out, errOut bytes.Buffer
	if code, _ := runMaintenanceCommand([]string{"set-user-role", "--email", "owner@example.com"}, &out, &errOut); code != 2 {
		t.Fatalf("missing --role must exit 2, got %d", code)
	}
	if code, _ := runMaintenanceCommand([]string{"set-user-role", "--email", "owner@example.com", "--role", "bogus"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "unknown role") {
		t.Fatalf("bogus role: code=%d stderr=%q", code, errOut.String())
	}
	errOut.Reset()
	code, handled := runMaintenanceCommand([]string{"set-user-role", "--email", "owner@example.com", "--role", "super_admin"}, &out, &errOut)
	if !handled || code != 0 {
		t.Fatalf("set-user-role: code=%d stderr=%q", code, errOut.String())
	}
	if !strings.Contains(out.String(), "is now super_admin") {
		t.Fatalf("stdout = %q", out.String())
	}
	db, err = store.Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, _, err := db.AuthUserByID(context.Background(), "usr_1")
	if err != nil || user.Role != "super_admin" {
		t.Fatalf("persisted user = %+v err=%v", user, err)
	}
}
