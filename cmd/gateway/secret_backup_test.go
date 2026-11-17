package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/secret"
)

func backupCommandFixture(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "backup.db")
	keyPath := filepath.Join(dir, "key")
	if err := os.WriteFile(keyPath, []byte("synthetic-backup-command-key"), 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		"CREATE TABLE provider_configs(encrypted_api_key TEXT)",
		"CREATE TABLE mcp_upstreams(encrypted_auth TEXT)",
		"CREATE TABLE text2sql_exec_connections(encrypted_dsn TEXT)",
		"CREATE TABLE admin_settings(value_json TEXT,is_secret INTEGER)",
		"CREATE TABLE sso_provider_config(client_secret_enc TEXT)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return path, keyPath
}

func TestVerifySecretBackupCommandResults(t *testing.T) {
	path, keyPath := backupCommandFixture(t)
	args := []string{"verify-secret-backup", "--sqlite", path, "--key-file", keyPath}
	var out, errOut bytes.Buffer
	code, handled := runMaintenanceCommand(args, &out, &errOut)
	if !handled || code != 3 || !strings.Contains(out.String(), `"status":"no_secrets"`) {
		t.Fatal("empty backup must not confirm a key")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	c, _ := secret.New("synthetic-backup-command-key")
	encrypted, _ := c.Encrypt("synthetic-private-command-value")
	if _, err := db.Exec("INSERT INTO provider_configs VALUES(?)", encrypted); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		key    string
		code   int
		status string
	}{
		{"synthetic-backup-command-key", 0, "matched"}, {"synthetic-wrong-key", 1, "mismatch"},
	} {
		if err := os.WriteFile(keyPath, []byte(tc.key), 0600); err != nil {
			t.Fatal(err)
		}
		out.Reset()
		errOut.Reset()
		code, _ = runMaintenanceCommand(args, &out, &errOut)
		var report struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(out.Bytes(), &report) != nil || code != tc.code || report.Status != tc.status || errOut.Len() != 0 {
			t.Fatal("unexpected command result")
		}
		for _, private := range []string{tc.key, encrypted, "synthetic-private-command-value", path, keyPath} {
			if strings.Contains(out.String()+errOut.String(), private) {
				t.Fatal("command output leaked private material")
			}
		}
	}
	if _, err := db.Exec("DROP TABLE sso_provider_config"); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	code, _ = runMaintenanceCommand(args, &out, &errOut)
	if code != 3 || out.Len() != 0 || strings.Contains(errOut.String(), "sso_provider_config") {
		t.Fatal("incomplete inspection must not report partial success or database details")
	}
}

func TestVerifySecretBackupRejectsAmbiguousInputs(t *testing.T) {
	path, keyPath := backupCommandFixture(t)
	t.Setenv("DB_DSN", path)
	t.Setenv("GATEWAY_SECRET", "synthetic-do-not-use-live-key")
	t.Setenv("SECRET_BACKUP_POSTGRES_DSN", "")
	for _, args := range [][]string{
		{}, {"--sqlite", path}, {"--key-file", keyPath},
		{"--sqlite", path, "--postgres", "--key-file", keyPath},
		{"--new-secret=synthetic-pasted-private"},
		{"--sqlite", path, "--key-file", keyPath, "synthetic-positional-private"},
	} {
		var out, errOut bytes.Buffer
		if code := runVerifySecretBackup(args, &out, &errOut); code != 2 || out.Len() != 0 {
			t.Fatal("invalid flags accepted")
		}
		if strings.Contains(errOut.String(), "synthetic-") || strings.Contains(errOut.String(), path) {
			t.Fatal("usage error echoed arguments")
		}
	}
	var out, errOut bytes.Buffer
	if code := runVerifySecretBackup([]string{"--postgres", "--key-file", keyPath}, &out, &errOut); code != 3 || out.Len() != 0 {
		t.Fatal("missing explicit restore DSN used live defaults")
	}
}

func TestVerifySecretBackupKeyFilePreservesBytes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "key")
	for _, value := range []string{"old key with spaces ", "key-with-final-newline\n", "\tkey\r\n"} {
		if err := os.WriteFile(p, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := readBackupKey(p)
		if err != nil || got != value {
			t.Fatal("key reader altered original key bytes")
		}
	}
	for _, value := range []string{"", strings.Repeat("x", 65537)} {
		if err := os.WriteFile(p, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readBackupKey(p); err == nil {
			t.Fatal("invalid key size accepted")
		}
	}
	if _, err := readBackupKey(filepath.Dir(p)); err == nil {
		t.Fatal("directory accepted as key")
	}
}
