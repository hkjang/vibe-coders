package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	AppUITelemetryRetentionDays = 30
	AppUITelemetryVisitLimit    = 100_000
)

var (
	ErrAppUITelemetryInvalidInput  = errors.New("invalid UI telemetry input")
	ErrAppUITelemetryVisitConflict = errors.New("UI telemetry visit belongs to another feature")
	appUITelemetryFeaturePattern   = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`)
)

// AppUITelemetryCount contains aggregates only. Neither the random visit ID nor
// its digest is returned to callers of the summary API.
type AppUITelemetryCount struct {
	FeatureID   string `json:"feature_id"`
	Visits      int64  `json:"visits"`
	LegacyOpens int64  `json:"legacy_opens"`
}

// RecordAppUITelemetry records one authorized feature visit or Legacy click.
// The caller must verify featureID against the UI registry and authorize the
// feature before calling. Store validation additionally bounds its shape.
//
// A duplicate for the same feature is accepted without adding another visit.
// A Legacy click may arrive first: it creates that visit with legacy_open=1,
// and a delayed visit never clears the flag. The first receipt time never moves.
// Reusing an ID for another feature fails, while a full store returns false,nil.
func (s *SQLStore) RecordAppUITelemetry(ctx context.Context, featureID, visitID string, legacyOpen bool, now time.Time) (bool, error) {
	if len(featureID) == 0 || len(featureID) > 64 || !appUITelemetryFeaturePattern.MatchString(featureID) ||
		len(visitID) != 32 || now.IsZero() || now.Unix() <= 0 {
		return false, ErrAppUITelemetryInvalidInput
	}
	// Require the canonical lowercase hex spelling so one visit cannot acquire
	// separate digests by changing the case of its identifier.
	for _, c := range visitID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false, ErrAppUITelemetryInvalidInput
		}
	}
	digest := sha256.Sum256([]byte(visitID))
	visitHash := hex.EncodeToString(digest[:])
	tx, cleanup, err := s.lockAppUITelemetry(ctx)
	if err != nil {
		return false, err
	}
	defer cleanup()
	if err := s.purgeAppUITelemetryTx(ctx, tx, now); err != nil {
		return false, err
	}

	var storedFeature string
	var storedLegacy int
	err = tx.QueryRowContext(ctx, s.bind(`SELECT feature_id, legacy_open
		FROM app_ui_telemetry_visits WHERE visit_hash = ?`), visitHash).Scan(&storedFeature, &storedLegacy)
	if err == nil {
		if storedFeature != featureID {
			return false, ErrAppUITelemetryVisitConflict
		}
		if legacyOpen && storedLegacy == 0 {
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_visits
				SET legacy_open = 1 WHERE visit_hash = ?`), visitHash); err != nil {
				return false, err
			}
		}
		if err := tx.Commit(); err != nil {
			return false, err
		}
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	reserved, err := tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity
		SET live_visits = live_visits + 1 WHERE singleton = 1 AND live_visits < ?`), AppUITelemetryVisitLimit)
	if err != nil {
		return false, err
	}
	n, err := reserved.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, tx.Commit()
	}
	legacy := 0
	if legacyOpen {
		legacy = 1
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO app_ui_telemetry_visits
		(visit_hash, feature_id, first_seen_epoch, legacy_open) VALUES (?, ?, ?, ?)`),
		visitHash, featureID, now.Unix(), legacy); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// AppUITelemetrySummary counts the first receipt of each visit. The requested
// window is clamped to 30 days even if the independent expiry worker is delayed.
func (s *SQLStore) AppUITelemetrySummary(ctx context.Context, since, now time.Time) ([]AppUITelemetryCount, error) {
	counts := []AppUITelemetryCount{}
	if now.IsZero() || now.Unix() <= 0 {
		return nil, ErrAppUITelemetryInvalidInput
	}
	if since.After(now) {
		return counts, nil
	}
	cutoff := now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour).Unix()
	if since.Unix() < cutoff {
		since = time.Unix(cutoff, 0)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT feature_id, COUNT(*), SUM(legacy_open)
		FROM app_ui_telemetry_visits
		WHERE first_seen_epoch > ? AND first_seen_epoch >= ? AND first_seen_epoch <= ?
		GROUP BY feature_id ORDER BY feature_id`), cutoff, since.Unix(), now.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var count AppUITelemetryCount
		if err := rows.Scan(&count.FeatureID, &count.Visits, &count.LegacyOpens); err != nil {
			return nil, err
		}
		counts = append(counts, count)
	}
	return counts, rows.Err()
}

// PurgeAppUITelemetry is also called by a lifecycle-bound cleanup loop even
// when telemetry collection or the general request-retention worker is off.
func (s *SQLStore) PurgeAppUITelemetry(ctx context.Context, now time.Time) error {
	if now.IsZero() || now.Unix() <= 0 {
		return ErrAppUITelemetryInvalidInput
	}
	tx, cleanup, err := s.lockAppUITelemetry(ctx)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := s.purgeAppUITelemetryTx(ctx, tx, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLStore) lockAppUITelemetry(ctx context.Context) (*sql.Tx, func(), error) {
	tx, cleanup, err := s.beginAppUITelemetryTx(ctx)
	if err != nil {
		return nil, nil, err
	}
	// Acquire a database write lock before any reads. PostgreSQL serializes on
	// this row; SQLite avoids the deferred read-to-write lock upgrade race.
	result, err := tx.ExecContext(ctx, `UPDATE app_ui_telemetry_capacity
		SET live_visits = live_visits WHERE singleton = 1`)
	if err == nil {
		var n int64
		n, err = result.RowsAffected()
		if err == nil && n != 1 {
			err = errors.New("UI telemetry capacity row is missing")
		}
	}
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return tx, cleanup, nil
}

// SQLite's busy handler can delay context cancellation for its entire configured
// timeout. These lossy metrics must not occupy the application's single SQLite
// connection for that wait. Lease the connection, cap only this transaction's
// lock wait, and restore the original setting before returning it to the pool.
// PostgreSQL's context-aware transaction path needs no connection setting change.
func (s *SQLStore) beginAppUITelemetryTx(ctx context.Context) (*sql.Tx, func(), error) {
	if s.dialect != "sqlite" {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, nil, err
		}
		return tx, func() { _ = tx.Rollback() }, nil
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, nil, err
	}
	var originalTimeout int
	if err := conn.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&originalTimeout); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	var tx *sql.Tx
	cleanup := func() {
		if tx != nil {
			_ = tx.Rollback()
		}
		// Request cancellation must not prevent restoring connection-local state.
		restoreCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		if _, err := conn.ExecContext(restoreCtx, fmt.Sprintf("PRAGMA busy_timeout = %d", originalTimeout)); err != nil {
			// Never return a connection with altered settings to unrelated work.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		_ = conn.Close()
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA busy_timeout = 50`); err != nil {
		cleanup()
		return nil, nil, err
	}
	tx, err = conn.BeginTx(ctx, nil)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return tx, cleanup, nil
}

func (s *SQLStore) purgeAppUITelemetryTx(ctx context.Context, tx *sql.Tx, now time.Time) error {
	cutoff := now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour).Unix()
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM app_ui_telemetry_visits
		WHERE first_seen_epoch <= ?`), cutoff)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity
		SET live_visits = live_visits - ? WHERE singleton = 1`), n)
	return err
}
