package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"vibe-coders/internal/secret"
)

func rotationFixture(t *testing.T) (*SQLStore, *secret.Cipher, *secret.Cipher) {
	t.Helper()
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	oldCipher, err := secret.New("rotation-test-old-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	newCipher, err := secret.New("rotation-test-new-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	return db, oldCipher, newCipher
}

func TestSecretRotationPreservesJSONSetting(t *testing.T) {
	db, oldCipher, newCipher := rotationFixture(t)
	encrypted, err := oldCipher.Encrypt("synthetic-setting-value")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAdminSetting(t.Context(), AdminSetting{
		Key: "UPSTREAM_API_KEY", Category: "gateway", ValueJSON: string(encoded), ValueType: "string", IsSecret: true,
	}, "test-admin", "initial synthetic setting"); err != nil {
		t.Fatal(err)
	}
	before, _, err := db.GetAdminSetting(t.Context(), "UPSTREAM_API_KEY")
	if err != nil {
		t.Fatal(err)
	}
	tokenBefore, err := db.AdminSettingsChangeToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	counts, err := db.RotateEncryptedColumns(t.Context(), oldCipher.Decrypt, newCipher.Encrypt)
	if err != nil {
		t.Fatal(err)
	}
	setting, found, err := db.GetAdminSetting(t.Context(), "UPSTREAM_API_KEY")
	if err != nil || !found {
		t.Fatal("rotated setting must remain available")
	}
	var ciphertext string
	if err := json.Unmarshal([]byte(setting.ValueJSON), &ciphertext); err != nil {
		t.Fatal("rotation must preserve JSON string storage")
	}
	plaintext, err := newCipher.Decrypt(ciphertext)
	if err != nil || plaintext != "synthetic-setting-value" || counts["admin_settings"] != 1 {
		t.Fatal("JSON-wrapped setting was not rotated to the new key")
	}
	if setting.Version != before.Version+1 {
		t.Fatal("rotation must invalidate the previous setting revision")
	}
	if err := db.UpsertAdminSetting(t.Context(), before, "test-admin", "stale edit"); !errors.Is(err, ErrAdminSettingConflict) {
		t.Fatalf("stale settings edit error = %v, want conflict", err)
	}
	tokenAfter, err := db.AdminSettingsChangeToken(t.Context())
	if err != nil || tokenBefore == tokenAfter {
		t.Fatal("rotation must invalidate the settings change token")
	}
}

func TestSecretRotationPreservesSSOClientSecret(t *testing.T) {
	db, oldCipher, newCipher := rotationFixture(t)
	encrypted, err := oldCipher.Encrypt("synthetic-sso-client-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveSSOProviderConfig(t.Context(), SSOProviderConfig{
		Provider: "keycloak", ClientID: "test-client", IssuerURL: "https://idp.example.test/realm",
		ClientSecretEnc: encrypted, AllowLocalLogin: true,
	}); err != nil {
		t.Fatal(err)
	}
	before, _, err := db.GetSSOProviderConfig(t.Context(), "keycloak")
	if err != nil {
		t.Fatal(err)
	}
	counts, err := db.RotateEncryptedColumns(t.Context(), oldCipher.Decrypt, newCipher.Encrypt)
	if err != nil {
		t.Fatal(err)
	}
	record, found, err := db.GetSSOProviderConfig(t.Context(), "keycloak")
	if err != nil || !found {
		t.Fatal("SSO configuration must remain available")
	}
	plaintext, err := newCipher.Decrypt(record.ClientSecretEnc)
	if err != nil || plaintext != "synthetic-sso-client-secret" || counts["sso_provider_config"] != 1 {
		t.Fatal("SSO client secret was not rotated to the new key")
	}
	if record.ClientID != "test-client" || record.IssuerURL != "https://idp.example.test/realm" || !record.AllowLocalLogin {
		t.Fatal("rotation changed non-secret SSO configuration")
	}
	if record.Version != before.Version+1 {
		t.Fatal("rotation must invalidate the previous SSO revision")
	}
	if err := db.SaveSSOProviderConfig(t.Context(), before); !errors.Is(err, ErrSSOConfigConflict) {
		t.Fatalf("stale SSO edit error = %v, want conflict", err)
	}
}

func TestSecretRotationRejectsCorruptSettingAtomically(t *testing.T) {
	for _, value := range []string{`"v1:damaged-ciphertext"`, `v1:damaged-ciphertext`, `null`, `{}`, `123`, `"plaintext"`, `"unterminated`} {
		t.Run(value, func(t *testing.T) {
			testSecretRotationRejectsCorruptSetting(t, value)
		})
	}
}

func testSecretRotationRejectsCorruptSetting(t *testing.T, value string) {
	db, oldCipher, newCipher := rotationFixture(t)
	encrypted, err := oldCipher.Encrypt("synthetic-provider-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), ProviderConfig{
		Name: "rotation-provider", BaseURL: "http://127.0.0.1:9", EncryptedAPIKey: encrypted,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAdminSetting(t.Context(), AdminSetting{
		Key: "UPSTREAM_API_KEY", Category: "gateway", ValueJSON: value, ValueType: "string", IsSecret: true,
	}, "test-admin", "synthetic corruption fixture"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RotateEncryptedColumns(t.Context(), oldCipher.Decrypt, newCipher.Encrypt); err == nil {
		t.Fatal("a corrupt secret must abort rotation instead of silently skipping it")
	}
	provider, found, err := db.GetProvider(t.Context(), "rotation-provider")
	if err != nil || !found {
		t.Fatal("provider must remain available after failed rotation")
	}
	plaintext, err := oldCipher.Decrypt(provider.EncryptedAPIKey)
	if err != nil || plaintext != "synthetic-provider-key" {
		t.Fatal("failed rotation committed a provider key change")
	}
}

// This fixture uses the normal writers for every secret-bearing store. It also
// includes a legacy raw setting and a plain setting that must remain untouched.
func seedRotationInventory(t *testing.T, db *SQLStore, cipher *secret.Cipher) {
	t.Helper()
	enc, err := cipher.Encrypt("synthetic-inventory-secret")
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range []error{
		db.UpsertProvider(t.Context(), ProviderConfig{Name: "provider", BaseURL: "http://127.0.0.1:9", EncryptedAPIKey: enc}),
		db.UpsertMCPUpstream(t.Context(), MCPUpstream{ID: "mcp", Name: "MCP", URL: "http://127.0.0.1:9", EncryptedAuth: enc}),
		db.UpsertText2SQLExecConnection(t.Context(), Text2SQLExecConnection{ID: "sql", Name: "SQL", Driver: "sqlite", EncryptedDSN: enc}),
		db.UpsertAdminSetting(t.Context(), AdminSetting{Key: "secret", ValueJSON: enc, ValueType: "string", IsSecret: true}, "test", "seed"),
		db.UpsertAdminSetting(t.Context(), AdminSetting{Key: "plain", ValueJSON: `"ordinary setting"`, ValueType: "string"}, "test", "seed"),
		db.SaveSSOProviderConfig(t.Context(), SSOProviderConfig{Provider: "keycloak", ClientID: "client", ClientSecretEnc: enc}),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func readRotationInventory(t *testing.T, db *SQLStore) map[string]string {
	t.Helper()
	values := make(map[string]string)
	for table, query := range map[string]string{
		"provider_configs":          `SELECT encrypted_api_key FROM provider_configs WHERE name='provider'`,
		"mcp_upstreams":             `SELECT encrypted_auth FROM mcp_upstreams WHERE id='mcp'`,
		"text2sql_exec_connections": `SELECT encrypted_dsn FROM text2sql_exec_connections WHERE id='sql'`,
		"admin_settings":            `SELECT value_json FROM admin_settings WHERE key='secret'`,
		"sso_provider_config":       `SELECT client_secret_enc FROM sso_provider_config WHERE provider='keycloak'`,
	} {
		var value string
		if err := db.db.QueryRowContext(t.Context(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		values[table] = value
	}
	return values
}

func TestSecretRotationCoversEveryEncryptedStore(t *testing.T) {
	db, oldCipher, newCipher := rotationFixture(t)
	seedRotationInventory(t, db, oldCipher)
	counts, err := db.RotateEncryptedColumns(t.Context(), oldCipher.Decrypt, newCipher.Encrypt)
	if err != nil {
		t.Fatal(err)
	}
	values := readRotationInventory(t, db)
	if len(counts) != len(values) {
		t.Fatal("rotation counts must include every encrypted store")
	}
	for table, value := range values {
		plaintext, err := newCipher.Decrypt(value)
		if err != nil || plaintext != "synthetic-inventory-secret" || counts[table] != 1 {
			t.Fatalf("%s was not rotated exactly once", table)
		}
		if _, err := oldCipher.Decrypt(value); err == nil {
			t.Fatalf("%s still accepts the retired key", table)
		}
	}
	plain, found, err := db.GetAdminSetting(t.Context(), "plain")
	if err != nil || !found || plain.ValueJSON != `"ordinary setting"` || plain.Version != 1 {
		t.Fatal("rotation changed a non-secret setting")
	}
}

func TestSecretRotationRollsBackEveryStoreOnEncryptionFailure(t *testing.T) {
	db, oldCipher, newCipher := rotationFixture(t)
	seedRotationInventory(t, db, oldCipher)
	before := readRotationInventory(t, db)
	settingBefore, _, _ := db.GetAdminSetting(t.Context(), "secret")
	ssoBefore, _, _ := db.GetSSOProviderConfig(t.Context(), "keycloak")
	calls := 0
	counts, err := db.RotateEncryptedColumns(t.Context(), oldCipher.Decrypt, func(value string) (string, error) {
		calls++
		if calls == len(before) {
			return "", errors.New("synthetic encryption failure")
		}
		return newCipher.Encrypt(value)
	})
	if err == nil || counts != nil || calls != len(before) {
		t.Fatal("failure in the final encrypted store must abort the operation")
	}
	if !reflect.DeepEqual(before, readRotationInventory(t, db)) {
		t.Fatal("failed rotation changed stored ciphertext")
	}
	settingAfter, _, _ := db.GetAdminSetting(t.Context(), "secret")
	ssoAfter, _, _ := db.GetSSOProviderConfig(t.Context(), "keycloak")
	if settingBefore.Version != settingAfter.Version || ssoBefore.Version != ssoAfter.Version {
		t.Fatal("failed rotation changed a configuration revision")
	}
}
