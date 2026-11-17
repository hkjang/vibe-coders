package secretbackup_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/secretbackup"
	"vibe-coders/internal/store"
)

// Exercises real gateway schema/writers/rotation and a restored, stopped SQLite
// database. It is a local recovery drill, not proof of an operator's backup.
func TestSecretBackupRotationRecovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gateway.db")
	cfg := config.DatabaseConfig{Driver: "sqlite", DSN: path}
	db, err := store.Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	oldKey, newKey := "synthetic-recovery-old-key", "synthetic-recovery-new-key"
	oldCipher, _ := secret.New(oldKey)
	newCipher, _ := secret.New(newKey)
	enc, _ := oldCipher.Encrypt("synthetic-recovery-private-value")
	wrapped, _ := json.Marshal(enc)
	for _, err := range []error{
		db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "recovery-provider", BaseURL: "http://127.0.0.1:9", EncryptedAPIKey: enc}),
		db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "mcp", Name: "MCP", URL: "http://127.0.0.1:9", EncryptedAuth: enc}),
		db.UpsertText2SQLExecConnection(t.Context(), store.Text2SQLExecConnection{ID: "sql", Name: "SQL", Driver: "sqlite", EncryptedDSN: enc}),
		db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "json-secret", ValueJSON: string(wrapped), ValueType: "string", IsSecret: true}, "test", "seed"),
		db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "raw-secret", ValueJSON: enc, ValueType: "string", IsSecret: true}, "test", "seed"),
		db.SaveSSOProviderConfig(t.Context(), store.SSOProviderConfig{Provider: "keycloak", ClientID: "client", ClientSecretEnc: enc}),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	backup, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(dir, "before.db")
	if err := os.WriteFile(backupPath, backup, 0400); err != nil {
		t.Fatal(err)
	}
	assertKey := func(file, key, status string) {
		t.Helper()
		r, err := secretbackup.SQLite(t.Context(), file, key)
		if err != nil || r.Status != status {
			t.Fatal("recovery key state incorrect")
		}
	}
	assertKey(backupPath, oldKey, "matched")
	assertKey(backupPath, newKey, "mismatch")
	db, err = store.Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	counts, err := db.RotateEncryptedColumnsWithAudit(t.Context(), oldCipher.Decrypt, newCipher.Encrypt, store.AdminAuditLog{ID: "recovery-rotation", AdminID: "test-admin", Action: "secrets.rotate"})
	if err != nil || len(counts) != 5 || counts["admin_settings"] != 2 {
		t.Fatal("real rotation incomplete")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	assertKey(path, newKey, "matched")
	assertKey(path, oldKey, "mismatch")
	// Restore into a separate path and reopen with the real store, leaving the
	// post-rotation database intact so both sides of the recovery remain testable.
	restored := filepath.Join(dir, "restored.db")
	if err := os.WriteFile(restored, backup, 0600); err != nil {
		t.Fatal(err)
	}
	assertKey(restored, oldKey, "matched")
	assertKey(restored, newKey, "mismatch")
	restoredDB, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: restored})
	if err != nil {
		t.Fatal(err)
	}
	defer restoredDB.Close()
	p, found, err := restoredDB.GetProvider(t.Context(), "recovery-provider")
	if err != nil || !found {
		t.Fatal("restored provider unavailable")
	}
	plain, err := oldCipher.Decrypt(p.EncryptedAPIKey)
	if err != nil || plain != "synthetic-recovery-private-value" {
		t.Fatal("restored provider cannot decrypt")
	}
	audits, err := restoredDB.ListAdminAudit(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, audit := range audits {
		if audit.Action == "secrets.rotate" {
			t.Fatal("restored backup contains a later rotation")
		}
	}
}
