package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"vibe-coders/internal/proxy"
)

func TestMaintenanceCommandIgnoresPlainStartup(t *testing.T) {
	var out, errOut bytes.Buffer
	if _, handled := runMaintenanceCommand(nil, &out, &errOut); handled {
		t.Fatal("no arguments must start the server, not a subcommand")
	}
	if _, handled := runMaintenanceCommand([]string{"-x"}, &out, &errOut); handled {
		t.Fatal("flag-like arguments are not subcommands")
	}
	code, handled := runMaintenanceCommand([]string{"bogus"}, &out, &errOut)
	if !handled || code != 2 || !strings.Contains(errOut.String(), "unknown command") {
		t.Fatalf("unknown subcommand: code=%d handled=%v stderr=%q", code, handled, errOut.String())
	}
}

func TestVersionCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	code, handled := runMaintenanceCommand([]string{"version"}, &out, &errOut)
	if !handled || code != 0 || strings.TrimSpace(out.String()) != proxy.AppVersion {
		t.Fatalf("version: code=%d handled=%v out=%q", code, handled, out.String())
	}
}

func TestCheckDataDirUsesDSNDirectoryByDefault(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DB_DRIVER", "sqlite")
	t.Setenv("DB_DSN", filepath.Join(dir, "gateway.db")+"?_pragma=journal_mode(WAL)")
	var out, errOut bytes.Buffer
	code, handled := runMaintenanceCommand([]string{"check-data-dir"}, &out, &errOut)
	if !handled || code != 0 {
		t.Fatalf("check-data-dir: code=%d handled=%v stderr=%q", code, handled, errOut.String())
	}
	if !strings.Contains(out.String(), "OK "+dir) {
		t.Fatalf("stdout should confirm the directory: %q", out.String())
	}
}

func TestCheckDataDirReportsRootOwnedDatabaseInsideWritableDirectory(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs enforced POSIX permission bits")
	}
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gateway.db")
	if err := os.WriteFile(dbPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dbPath, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dbPath, 0o644) })
	t.Setenv("DB_DSN", dbPath)
	t.Setenv("GATEWAY_VERSION", "v1.2.3")

	var out, errOut bytes.Buffer
	code, _ := runMaintenanceCommand([]string{"check-data-dir", dir}, &out, &errOut)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d (stdout=%q stderr=%q)", code, out.String(), errOut.String())
	}
	for _, want := range []string{dbPath, "cannot open for writing", "ai-coding-proxy-gateway:v1.2.3 repair-data-dir " + dir} {
		if !strings.Contains(errOut.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, errOut.String())
		}
	}
}

func TestRepairDataDirThenCheckSucceeds(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("repair is a POSIX operation")
	}
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gateway.db")
	if err := os.WriteFile(dbPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dbPath, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dbPath, 0o644) })
	t.Setenv("DB_DSN", dbPath)

	var out, errOut bytes.Buffer
	uid, gid := os.Getuid(), os.Getgid()
	code, _ := runMaintenanceCommand([]string{"repair-data-dir", "--uid", strconv.Itoa(uid), "--gid", strconv.Itoa(gid), dir}, &out, &errOut)
	if code != 0 {
		t.Fatalf("repair-data-dir: code=%d stderr=%q", code, errOut.String())
	}
	if !strings.Contains(out.String(), "chmod "+dbPath) {
		t.Fatalf("repair output should list the fixed file:\n%s", out.String())
	}
	out.Reset()
	errOut.Reset()
	if code, _ := runMaintenanceCommand([]string{"check-data-dir", dir}, &out, &errOut); code != 0 {
		t.Fatalf("check after repair: code=%d stderr=%q", code, errOut.String())
	}
	if code, _ := runMaintenanceCommand([]string{"repair-data-dir", "--uid", "-1", dir}, &out, &errOut); code != 2 {
		t.Fatalf("negative uid must be rejected, got code %d", code)
	}
	if code, _ := runMaintenanceCommand([]string{"repair-data-dir", dir, "extra"}, &out, &errOut); code != 2 {
		t.Fatalf("two directories must be rejected, got code %d", code)
	}
}

func TestDescribeStartupErrorAppendsHintOnlyForReadonlyFailures(t *testing.T) {
	t.Setenv("GATEWAY_VERSION", "v1.2.3")
	plain := errors.New("connection refused")
	if got := describeStartupError(plain, "/data/gateway.db"); got != plain {
		t.Fatalf("unrelated errors must pass through unchanged, got %v", got)
	}
	got := describeStartupError(errors.New("attempt to write a readonly database (8)"), "/srv/state/gateway.db?_pragma=x")
	if !strings.Contains(got.Error(), "repair-data-dir /srv/state") {
		t.Fatalf("readonly failure should carry the repair hint for the DSN directory: %v", got)
	}
	if describeStartupError(nil, "") != nil {
		t.Fatal("nil stays nil")
	}
}
