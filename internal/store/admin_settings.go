package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"
)

var ErrAdminSettingConflict = errors.New("admin setting changed concurrently")

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
	Key             string `json:"key"`
	Category        string `json:"category"`
	ValueJSON       string `json:"value_json"`
	ValueType       string `json:"value_type"`
	IsSecret        bool   `json:"is_secret"`
	Source          string `json:"source"`
	Version         int    `json:"version"`
	ExpectedVersion *int   `json:"-"`
	UpdatedBy       string `json:"updated_by"`
	UpdatedAt       string `json:"updated_at"`
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

// AdminSettingsChangeToken returns a token for all DB-backed settings consumed by the runtime
// reload loop. The admin_settings aggregate changes on upserts and deletes. The SSO digest covers
// every provider field so a Keycloak update made on one pod also reloads every other pod, even if
// two writes happen to receive the same updated_at value. The digest prevents secrets from being
// exposed through pod-status change tokens.
func (s *SQLStore) AdminSettingsChangeToken(ctx context.Context) (string, error) {
	var count, versionSum int64
	var maxUpdated string
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(version), 0), COALESCE(MAX(updated_at), '') FROM admin_settings`)
	if err := row.Scan(&count, &versionSum, &maxUpdated); err != nil {
		return "", err
	}

	ssoRows, err := s.db.QueryContext(ctx, `SELECT provider, enabled, issuer_url, client_id, client_secret_enc,
		redirect_uri, scopes, default_role, role_claim, group_claim, allow_local_login,
		COALESCE(role_map, ''), updated_at, COALESCE(updated_by, '')
		FROM sso_provider_config ORDER BY provider`)
	if err != nil {
		return "", err
	}
	defer ssoRows.Close()

	ssoDigest := sha256.New()
	writeDigestPart := func(value string) {
		_, _ = ssoDigest.Write(strconv.AppendInt(nil, int64(len(value)), 10))
		_, _ = ssoDigest.Write([]byte{':'})
		_, _ = ssoDigest.Write([]byte(value))
	}
	for ssoRows.Next() {
		var (
			provider, issuerURL, clientID, clientSecretEnc, redirectURI string
			scopes, defaultRole, roleClaim, groupClaim, roleMap         string
			updatedAt, updatedBy                                        string
			enabled, allowLocalLogin                                    int64
		)
		if err := ssoRows.Scan(&provider, &enabled, &issuerURL, &clientID, &clientSecretEnc,
			&redirectURI, &scopes, &defaultRole, &roleClaim, &groupClaim, &allowLocalLogin,
			&roleMap, &updatedAt, &updatedBy); err != nil {
			return "", err
		}
		for _, part := range []string{
			provider,
			strconv.FormatInt(enabled, 10),
			issuerURL,
			clientID,
			clientSecretEnc,
			redirectURI,
			scopes,
			defaultRole,
			roleClaim,
			groupClaim,
			strconv.FormatInt(allowLocalLogin, 10),
			roleMap,
			updatedAt,
			updatedBy,
		} {
			writeDigestPart(part)
		}
	}
	if err := ssoRows.Err(); err != nil {
		return "", err
	}
	featureRows, err := s.db.QueryContext(ctx, `SELECT name, enabled, COALESCE(updated_at, '')
		FROM text2sql_feature_flags ORDER BY name`)
	if err != nil {
		return "", err
	}
	defer featureRows.Close()
	featureDigest := sha256.New()
	for featureRows.Next() {
		var name, updatedAt string
		var enabled int64
		if err := featureRows.Scan(&name, &enabled, &updatedAt); err != nil {
			return "", err
		}
		for _, part := range []string{name, strconv.FormatInt(enabled, 10), updatedAt} {
			_, _ = featureDigest.Write(strconv.AppendInt(nil, int64(len(part)), 10))
			_, _ = featureDigest.Write([]byte{':'})
			_, _ = featureDigest.Write([]byte(part))
		}
	}
	if err := featureRows.Err(); err != nil {
		return "", err
	}

	return strconv.FormatInt(count, 10) + ":" + strconv.FormatInt(versionSum, 10) + ":" + maxUpdated +
		":sso-sha256:" + hex.EncodeToString(ssoDigest.Sum(nil)) +
		":t2s-sha256:" + hex.EncodeToString(featureDigest.Sum(nil)), nil
}

// ListAdminSettings returns all stored admin settings.
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
	return s.UpsertAdminSettings(ctx, []AdminSetting{a}, changedBy, reason)
}

// UpsertAdminSettings applies a validated settings batch and all history rows in one
// transaction. Each existing row uses a version compare-and-swap so concurrent pods
// cannot silently overwrite one another with the same version.
func (s *SQLStore) UpsertAdminSettings(ctx context.Context, settings []AdminSetting, changedBy, reason string) error {
	if len(settings) == 0 {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	seen := make(map[string]struct{}, len(settings))
	for _, setting := range settings {
		if setting.Key == "" {
			return fmt.Errorf("admin setting key is required")
		}
		if _, exists := seen[setting.Key]; exists {
			return fmt.Errorf("duplicate admin setting key %q", setting.Key)
		}
		seen[setting.Key] = struct{}{}
		if err := s.upsertAdminSettingTx(ctx, tx, setting, changedBy, reason, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLStore) upsertAdminSettingTx(ctx context.Context, tx *sql.Tx, a AdminSetting, changedBy, reason, now string) error {
	var oldValue string
	var oldVersion int
	row := tx.QueryRowContext(ctx, s.bind(`SELECT value_json, version FROM admin_settings WHERE key = ?`), a.Key)
	found := true
	switch err := row.Scan(&oldValue, &oldVersion); {
	case errors.Is(err, sql.ErrNoRows):
		found = false
		oldVersion = 0
	case err != nil:
		return err
	}
	expectedVersion := a.Version
	if a.ExpectedVersion != nil {
		expectedVersion = *a.ExpectedVersion
	}
	if (a.ExpectedVersion != nil || a.Version > 0) && expectedVersion != oldVersion {
		return fmt.Errorf("%w: %s expected version %d, current version %d", ErrAdminSettingConflict, a.Key, expectedVersion, oldVersion)
	}
	a.Version = oldVersion + 1
	if a.Source == "" {
		a.Source = "admin"
	}
	isSecret := 0
	if a.IsSecret {
		isSecret = 1
	}
	var result sql.Result
	var err error
	if found {
		result, err = tx.ExecContext(ctx, s.bind(`UPDATE admin_settings SET
			category = ?, value_json = ?, value_type = ?, is_secret = ?, source = ?,
			version = ?, updated_by = ?, updated_at = ? WHERE key = ? AND version = ?`),
			a.Category, a.ValueJSON, a.ValueType, isSecret, a.Source,
			a.Version, changedBy, now, a.Key, oldVersion)
	} else {
		result, err = tx.ExecContext(ctx, s.bind(`INSERT INTO admin_settings
			(key, category, value_json, value_type, is_secret, source, version, updated_by, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`),
			a.Key, a.Category, a.ValueJSON, a.ValueType, isSecret, a.Source, a.Version, changedBy, now)
	}
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("%w: %s", ErrAdminSettingConflict, a.Key)
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
	return nil
}

// DeleteAdminSetting removes a stored override (reverting the key to env/default), recording
// history. Callers may pass an expected version. Without one, the version read in this transaction
// is still used by the DELETE compare-and-swap so a concurrent update cannot be silently removed.
func (s *SQLStore) DeleteAdminSetting(ctx context.Context, key, changedBy, reason string, expectedVersions ...int) error {
	if len(expectedVersions) > 1 {
		return fmt.Errorf("at most one expected admin setting version may be supplied")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldValue string
	var isSecret, currentVersion int
	row := tx.QueryRowContext(ctx, s.bind(`SELECT value_json, is_secret, version FROM admin_settings WHERE key = ?`), key)
	if err := row.Scan(&oldValue, &isSecret, &currentVersion); errors.Is(err, sql.ErrNoRows) {
		if len(expectedVersions) == 1 && expectedVersions[0] != 0 {
			return fmt.Errorf("%w: %s expected version %d, current setting does not exist", ErrAdminSettingConflict, key, expectedVersions[0])
		}
		return nil
	} else if err != nil {
		return err
	}
	if len(expectedVersions) == 1 && expectedVersions[0] != currentVersion {
		return fmt.Errorf("%w: %s expected version %d, current version %d", ErrAdminSettingConflict, key, expectedVersions[0], currentVersion)
	}
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM admin_settings WHERE key = ? AND version = ?`), key, currentVersion)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("%w: %s", ErrAdminSettingConflict, key)
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
