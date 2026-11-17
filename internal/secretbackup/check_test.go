package secretbackup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/secret"
)

const testKey = "synthetic-backup-key-old"

func fixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "backup.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, item := range inventory {
		columns := item.column + " TEXT"
		if item.table == "admin_settings" {
			columns += ", is_secret INTEGER"
		}
		if _, err := db.ExecContext(t.Context(), "CREATE TABLE "+item.table+" ("+columns+")"); err != nil {
			t.Fatal(err)
		}
	}
	return db, path
}

func ciphertext(t *testing.T, key string) string {
	t.Helper()
	c, _ := secret.New(key)
	value, err := c.Encrypt("synthetic-secret-payload-do-not-output")
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func seed(t *testing.T, db *sql.DB) {
	t.Helper()
	value := ciphertext(t, testKey)
	for _, item := range inventory {
		query := "INSERT INTO " + item.table + "(" + item.column + ") VALUES($1)"
		if item.table == "admin_settings" {
			query = "INSERT INTO admin_settings(value_json,is_secret) VALUES($1,1)"
		}
		if _, err := db.ExecContext(t.Context(), query, value); err != nil {
			t.Fatal(err)
		}
	}
	wrapped, _ := json.Marshal(value)
	if _, err := db.ExecContext(t.Context(), "INSERT INTO admin_settings(value_json,is_secret) VALUES($1,1),('public',0)", string(wrapped)); err != nil {
		t.Fatal(err)
	}
}

func TestSecretBackupInspection(t *testing.T) {
	db, path := fixture(t)
	seed(t, db)
	before, _ := os.ReadFile(path)
	got, err := SQLite(t.Context(), path, testKey)
	if err != nil || got.Status != "matched" || len(got.Stores) != 5 {
		t.Fatal("valid backup not matched")
	}
	for _, row := range got.Stores {
		want := 1
		if row.Store == "admin_settings" {
			want = 2
		}
		if row.Matched != want || row.Failed != 0 {
			t.Fatal("wrong inventory count")
		}
	}
	wrong, err := SQLite(t.Context(), path, "wrong-key")
	if err != nil || wrong.Status != "mismatch" {
		t.Fatal("wrong key must fail authentication")
	}
	for _, row := range wrong.Stores {
		if row.Matched != 0 || row.Failed == 0 {
			t.Fatal("wrong key was accepted")
		}
	}
	after, _ := os.ReadFile(path)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("inspection changed the database")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatal("inspection created sidecars")
	}
	encoded, _ := json.Marshal(got)
	for _, forbidden := range []string{testKey, "synthetic-secret-payload-do-not-output", "v1:", path} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("report contains private material")
		}
	}
}

func TestSecretBackupMixedAndDamagedValues(t *testing.T) {
	db, path := fixture(t)
	seed(t, db)
	for _, value := range []any{ciphertext(t, "other-key"), "plaintext", `"plaintext"`, "v1:broken", nil, strings.Repeat("a", maxCiphertextBytes+1)} {
		if _, err := db.Exec("INSERT INTO provider_configs VALUES(?)", value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"", `""`} {
		if _, err := db.Exec("INSERT INTO admin_settings VALUES(?,1)", value); err != nil {
			t.Fatal(err)
		}
	}
	r, err := SQLite(t.Context(), path, testKey)
	if err != nil || r.Status != "mismatch" || r.Stores[0].Matched != 1 || r.Stores[0].Failed != 6 || r.Stores[3].Empty != 2 {
		t.Fatal("mixed or malformed inventory misclassified")
	}
}

func TestSecretBackupEmptyCannotConfirmKey(t *testing.T) {
	db, path := fixture(t)
	if _, err := db.Exec("INSERT INTO admin_settings VALUES('ordinary',0),('\"\"',1)"); err != nil {
		t.Fatal(err)
	}
	r, err := SQLite(t.Context(), path, testKey)
	if err != nil || r.Status != "no_secrets" {
		t.Fatal("empty registry must not confirm a key")
	}
}

func TestSecretBackupIncompleteNeverReturnsPartial(t *testing.T) {
	db, path := fixture(t)
	seed(t, db)
	if _, err := db.Exec("DROP TABLE sso_provider_config"); err != nil {
		t.Fatal(err)
	}
	r, err := SQLite(t.Context(), path, testKey)
	if err == nil || r.Status != "" || len(r.Stores) != 0 {
		t.Fatal("incomplete schema returned an apparently complete report")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r, err = SQLite(ctx, path, testKey)
	if err == nil || r.Status != "" {
		t.Fatal("cancelled inspection returned a report")
	}
}

func TestSecretBackupSQLiteIsReadOnly(t *testing.T) {
	_, path := fixture(t)
	db, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("INSERT INTO provider_configs VALUES('must-not-write')"); err == nil {
		t.Fatal("backup connection allows writes")
	}
	for _, suffix := range []string{"-wal", "-journal"} {
		if err := os.WriteFile(path+suffix, []byte("uncheckpointed"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := openSQLite(path); err == nil {
			t.Fatal("unsafe sidecar accepted")
		}
		if err := os.Remove(path + suffix); err != nil {
			t.Fatal(err)
		}
	}
	missing := filepath.Join(t.TempDir(), "missing.db")
	if _, err := openSQLite(missing); err == nil {
		t.Fatal("nonexistent backup accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("missing backup was created")
	}
	if _, err := openSQLite(filepath.Dir(path)); err == nil {
		t.Fatal("directory accepted")
	}
}

func TestSecretBackupPostgreSQLReadOnly(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL test service")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal("invalid isolated DSN")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("open isolated PostgreSQL")
	}
	defer admin.Close()
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	schema := "backupcheck_" + hex.EncodeToString(random[:])
	if _, err := admin.ExecContext(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal("create isolated schema")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanup, err := sql.Open("pgx", dsn)
		if err == nil {
			defer cleanup.Close()
			_, err = cleanup.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE")
		}
		if err != nil {
			t.Error("cleanup isolated schema")
		}
	})
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal("open isolated schema")
	}
	defer db.Close()
	for _, item := range inventory {
		columns := item.column + " TEXT"
		if item.table == "admin_settings" {
			columns += ",is_secret INTEGER"
		}
		if _, err := db.Exec("CREATE TABLE " + item.table + " (" + columns + ")"); err != nil {
			t.Fatal("seed isolated schema")
		}
	}
	seed(t, db)
	r, err := PostgreSQL(t.Context(), u.String(), testKey)
	if err != nil || r.Status != "matched" {
		t.Fatal("PostgreSQL key match failed")
	}
	r, err = PostgreSQL(t.Context(), u.String(), "wrong-key")
	if err != nil || r.Status != "mismatch" {
		t.Fatal("PostgreSQL wrong key not rejected")
	}
	if _, err := db.Exec("UPDATE provider_configs SET encrypted_api_key='v1:damaged'"); err != nil {
		t.Fatal(err)
	}
	r, err = PostgreSQL(t.Context(), u.String(), testKey)
	if err != nil || r.Status != "mismatch" || r.Stores[0].Failed != 1 {
		t.Fatal("PostgreSQL corruption not identified")
	}
	// A caller setting a writable session default must not override inspection's
	// read-only transaction. Test through a function invoked by a view.
	if _, err := db.Exec(`CREATE TABLE write_probe(value INTEGER); ALTER TABLE provider_configs RENAME TO encrypted_original;
CREATE FUNCTION forbidden_probe() RETURNS TEXT LANGUAGE plpgsql AS $$ BEGIN INSERT INTO write_probe VALUES(1); RETURN ''; END $$;
CREATE VIEW provider_configs AS SELECT forbidden_probe() AS encrypted_api_key`); err != nil {
		t.Fatal("prepare readonly enforcement probe")
	}
	q.Set("default_transaction_read_only", "off")
	u.RawQuery = q.Encode()
	r, err = PostgreSQL(t.Context(), u.String(), testKey)
	if err == nil || r.Status != "" {
		t.Fatal("readonly probe was allowed")
	}
	var writes int
	if err := db.QueryRow("SELECT COUNT(*) FROM write_probe").Scan(&writes); err != nil || writes != 0 {
		t.Fatal("inspection committed a write")
	}
}
