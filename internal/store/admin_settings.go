package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"time"
)

// newStoreID makes a unique id for store-originated rows (e.g. setting history).
func newStoreID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return prefix + "_" + time.Now().UTC().Format("20060102150405.000000000")
	}
	return prefix + "_" + hex.EncodeToString(b)
}

// AdminSetting is one admin-managed runtime configuration value. value_json holds the
// JSON-encoded value (or, for secrets, the encrypted ciphertext). value_type tells the
// caller how to decode it (string/int/bool/float/duration/csv).
type AdminSetting struct {
	Key       string `json:"key"`
	Category  string `json:"category"`
	ValueJSON string `json:"value_json"`
	ValueType string `json:"value_type"`
	IsSecret  bool   `json:"is_secret"`
	Source    string `json:"source"`
	Version   int    `json:"version"`
	UpdatedBy string `json:"updated_by"`
	UpdatedAt string `json:"updated_at"`
}

// AdminSettingHistory is one change record for a setting.
type AdminSettingHistory struct {
	ID           string `json:"id"`
	Key          string `json:"key"`
	OldValueJSON string `json:"old_value_json"`
	NewValueJSON string `json:"new_value_json"`
	IsSecret     bool   `json:"is_secret"`
	ChangedBy    string `json:"changed_by"`
	Reason       string `json:"reason"`
	ChangedAt    string `json:"changed_at"`
}

// ListAdminSettings returns all stored admin settings.
// AdminSettingsChangeToken returns a cheap token that changes whenever the admin_settings table
// changes — MAX(updated_at) advances on any upsert, COUNT(*) and SUM(version) shift on deletes or
// re-creates. A background reloader polls this so every pod converges after a change made on any
// pod, without a restart.
func (s *SQLStore) AdminSettingsChangeToken(ctx context.Context) (string, error) {
	var count, versionSum int64
	var maxUpdated string
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(version), 0), COALESCE(MAX(updated_at), '') FROM admin_settings`)
	if err := row.Scan(&count, &versionSum, &maxUpdated); err != nil {
		return "", err
	}
	return strconv.FormatInt(count, 10) + ":" + strconv.FormatInt(versionSum, 10) + ":" + maxUpdated, nil
}

func (s *SQLStore) ListAdminSettings(ctx context.Context) ([]AdminSetting, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, category, value_json, value_type, is_secret, source, version, COALESCE(updated_by, ''), updated_at
		FROM admin_settings ORDER BY category, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminSetting{}
	for rows.Next() {
		var a AdminSetting
		var isSecret int
		if err := rows.Scan(&a.Key, &a.Category, &a.ValueJSON, &a.ValueType, &isSecret, &a.Source, &a.Version, &a.UpdatedBy, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.IsSecret = isSecret == 1
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetAdminSetting returns one stored setting by key.
func (s *SQLStore) GetAdminSetting(ctx context.Context, key string) (AdminSetting, bool, error) {
	var a AdminSetting
	var isSecret int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT key, category, value_json, value_type, is_secret, source, version, COALESCE(updated_by, ''), updated_at
		FROM admin_settings WHERE key = ?`), key).
		Scan(&a.Key, &a.Category, &a.ValueJSON, &a.ValueType, &isSecret, &a.Source, &a.Version, &a.UpdatedBy, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminSetting{}, false, nil
	}
	if err != nil {
		return AdminSetting{}, false, err
	}
	a.IsSecret = isSecret == 1
	return a, true, nil
}

// UpsertAdminSetting writes a setting and appends a history row, bumping the version. The
// history records value hashes for secrets (the new/old JSON is omitted for secrets).
func (s *SQLStore) UpsertAdminSetting(ctx context.Context, a AdminSetting, changedBy, reason string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var oldValue string
	var oldVersion int
	row := tx.QueryRowContext(ctx, s.bind(`SELECT value_json, version FROM admin_settings WHERE key = ?`), a.Key)
	switch err := row.Scan(&oldValue, &oldVersion); {
	case errors.Is(err, sql.ErrNoRows):
		oldVersion = 0
	case err != nil:
		return err
	}
	a.Version = oldVersion + 1
	if a.Source == "" {
		a.Source = "admin"
	}
	isSecret := 0
	if a.IsSecret {
		isSecret = 1
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO admin_settings (key, category, value_json, value_type, is_secret, source, version, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			category = excluded.category,
			value_json = excluded.value_json,
			value_type = excluded.value_type,
			is_secret = excluded.is_secret,
			source = excluded.source,
			version = excluded.version,
			updated_by = excluded.updated_by,
			updated_at = excluded.updated_at`),
		a.Key, a.Category, a.ValueJSON, a.ValueType, isSecret, a.Source, a.Version, changedBy, now); err != nil {
		return err
	}
	// History: omit raw secret values (store empty so only the change fact is kept).
	histOld, histNew := oldValue, a.ValueJSON
	if a.IsSecret {
		histOld, histNew = "", ""
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO admin_setting_history (id, key, old_value_json, new_value_json, is_secret, changed_by, reason, changed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		newStoreID("ash"), a.Key, histOld, histNew, isSecret, changedBy, reason, now); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteAdminSetting removes a stored override (reverting the key to env/default), recording history.
func (s *SQLStore) DeleteAdminSetting(ctx context.Context, key, changedBy, reason string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldValue string
	var isSecret int
	row := tx.QueryRowContext(ctx, s.bind(`SELECT value_json, is_secret FROM admin_settings WHERE key = ?`), key)
	if err := row.Scan(&oldValue, &isSecret); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM admin_settings WHERE key = ?`), key); err != nil {
		return err
	}
	if isSecret == 1 {
		oldValue = ""
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO admin_setting_history (id, key, old_value_json, new_value_json, is_secret, changed_by, reason, changed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		newStoreID("ash"), key, oldValue, "", isSecret, changedBy, reason, now); err != nil {
		return err
	}
	return tx.Commit()
}

// ListAdminSettingHistory returns change history, optionally filtered by key, newest-first.
func (s *SQLStore) ListAdminSettingHistory(ctx context.Context, key string, limit int) ([]AdminSettingHistory, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	where := ""
	args := []any{}
	if key != "" {
		where = "WHERE key = ?"
		args = append(args, key)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, key, COALESCE(old_value_json, ''), COALESCE(new_value_json, ''), is_secret, COALESCE(changed_by, ''), COALESCE(reason, ''), changed_at
		FROM admin_setting_history `+where+` ORDER BY changed_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminSettingHistory{}
	for rows.Next() {
		var h AdminSettingHistory
		var isSecret int
		if err := rows.Scan(&h.ID, &h.Key, &h.OldValueJSON, &h.NewValueJSON, &isSecret, &h.ChangedBy, &h.Reason, &h.ChangedAt); err != nil {
			return nil, err
		}
		h.IsSecret = isSecret == 1
		out = append(out, h)
	}
	return out, rows.Err()
}
