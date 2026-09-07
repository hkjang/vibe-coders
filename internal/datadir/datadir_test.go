package datadir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSQLitePath(t *testing.T) {
	cases := []struct {
		dsn  string
		want string
		ok   bool
	}{
		{"/data/gateway.db", "/data/gateway.db", true},
		{"/data/gateway.db?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)", "/data/gateway.db", true},
		{"file:/data/gateway.db?mode=rwc", "/data/gateway.db", true},
		{"data/gateway.db", "data/gateway.db", true},
		{":memory:", "", false},
		{"file::memory:?cache=shared", "", false},
		{"file:test.db?mode=memory&cache=shared", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		got, ok := SQLitePath(tc.dsn)
		if got != tc.want || ok != tc.ok {
			t.Errorf("SQLitePath(%q) = (%q, %v), want (%q, %v)", tc.dsn, got, ok, tc.want, tc.ok)
		}
	}
}

// requirePOSIXPermissions skips tests whose assertions depend on the kernel
// enforcing mode bits against this process: Windows ignores them and root
// bypasses them.
func requirePOSIXPermissions(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not enforced on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission bits; the failure cannot be provoked")
	}
}

func restorable(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o755) })
}

func TestCheckPassesOnWritableDirectory(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gateway.db")
	if err := Check(dbPath); err != nil {
		t.Fatalf("fresh directory: %v", err)
	}
	if err := os.WriteFile(dbPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Check(dbPath); err != nil {
		t.Fatalf("existing writable database: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".gateway-write-check") {
			t.Fatalf("probe file %s was left behind", e.Name())
		}
	}
}

func TestCheckReportsUnwritableDirectory(t *testing.T) {
	requirePOSIXPermissions(t)
	t.Setenv("GATEWAY_VERSION", "v9.9.9")
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	restorable(t, dir, 0o555)

	err := Check(filepath.Join(dir, "gateway.db"))
	var dataErr *Error
	if !errors.As(err, &dataErr) {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if len(dataErr.Problems) != 1 || dataErr.Problems[0].Path != dir {
		t.Fatalf("expected one problem on %s, got %+v", dir, dataErr.Problems)
	}
	msg := err.Error()
	for _, want := range []string{
		dir,
		"uid=",
		"ai-coding-proxy-gateway:v9.9.9 repair-data-dir " + dir,
		"--user 0:0",
		"check-data-dir " + dir,
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message lacks %q:\n%s", want, msg)
		}
	}
}

func TestCheckReportsReadOnlyDatabaseAndSidecars(t *testing.T) {
	requirePOSIXPermissions(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gateway.db")
	for _, name := range []string{"gateway.db", "gateway.db-wal", "gateway.db-shm"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		restorable(t, p, 0o444)
	}

	err := Check(dbPath)
	var dataErr *Error
	if !errors.As(err, &dataErr) {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	var paths []string
	for _, p := range dataErr.Problems {
		paths = append(paths, filepath.Base(p.Path))
		if p.Owner == "" {
			t.Errorf("problem %s has no owner information", p.Path)
		}
	}
	if strings.Join(paths, ",") != "gateway.db,gateway.db-wal,gateway.db-shm" {
		t.Fatalf("unexpected problem set %v (the directory itself is writable and must not be listed)", paths)
	}
}

func TestRepairRestoresOwnerAccessAndPreservesOtherBits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("repair is a POSIX operation")
	}
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(root, "gateway.db")
	wal := filepath.Join(root, "gateway.db-wal")
	deep := filepath.Join(nested, "fallback.ndjson")
	for _, p := range []string{dbPath, wal, deep} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	restorable(t, dbPath, 0o444)
	restorable(t, wal, 0o400)
	restorable(t, deep, 0o444)
	restorable(t, nested, 0o555)

	summary, err := Repair(root, os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatalf("Repair: %v", err)
	}
	if summary.Visited != 5 {
		t.Errorf("visited %d entries, want 5 (root, nested, 3 files)", summary.Visited)
	}
	wantMode := map[string]os.FileMode{dbPath: 0o644, wal: 0o600, deep: 0o644, nested: 0o755}
	for p, want := range wantMode {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s mode %s, want %s", p, info.Mode().Perm(), want)
		}
	}
	if len(summary.Chmoded) != 4 {
		t.Errorf("chmoded %v, want the four entries that lacked owner write/exec", summary.Chmoded)
	}
	if err := Check(dbPath); err != nil {
		t.Fatalf("Check after Repair: %v", err)
	}

	again, err := Repair(root, os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatalf("second Repair: %v", err)
	}
	if len(again.Chowned)+len(again.Chmoded) != 0 {
		t.Errorf("Repair is not idempotent: %+v", again)
	}
}

func TestRepairDoesNotFollowSymlinksOutOfTheTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("repair is a POSIX operation")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "secret")
	if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	restorable(t, victim, 0o444)

	root := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(root, "escape-file")); err != nil {
		t.Fatal(err)
	}

	if _, err := Repair(root, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("Repair: %v", err)
	}
	info, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("file outside the tree was modified through a symlink: mode %s", info.Mode().Perm())
	}
}

func TestRepairRejectsNonDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("repair is a POSIX operation")
	}
	file := filepath.Join(t.TempDir(), "gateway.db")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Repair(file, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected an error for a file argument")
	}
	if _, err := Repair(filepath.Join(file, "missing"), os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected an error for a missing directory")
	}
}
