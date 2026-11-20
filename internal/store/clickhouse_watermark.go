package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"time"
)

// ClickHouseSinkState is the per-dimension watermark: the last day successfully
// shipped to ClickHouse and when. It lets operators see sink progress at a glance
// instead of inferring it from logs.
type ClickHouseSinkState struct {
	Dimension     string `json:"dimension"`
	LastSyncedDay string `json:"last_synced_day"`
	LastSyncedID  string `json:"-"`
	LastSuccessAt string `json:"last_success_at"`
	RowsSent      int64  `json:"rows_sent"`
	UpdatedAt     string `json:"updated_at"`
}

// ClickHouseSinkRetry is a persisted sink failure awaiting reprocessing. One row per
// dimension (the earliest unacknowledged window is retained), with an attempt counter.
type ClickHouseSinkRetry struct {
	Dimension     string `json:"dimension"`
	SinceDay      string `json:"since_day"`
	Error         string `json:"error"`
	Attempts      int64  `json:"attempts"`
	FirstFailedAt string `json:"first_failed_at"`
	LastAttemptAt string `json:"last_attempt_at"`
}

// RecordClickHouseSinkFailure retains the earliest unacknowledged source window
// while updating the latest error and failure generation for a dimension.
func (s *SQLStore) RecordClickHouseSinkFailure(ctx context.Context, dimension, sinceDay, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_sink_retry (dimension, since_day, error, attempts, first_failed_at, last_attempt_at)
		VALUES (?, ?, ?, 1, ?, ?)
		ON CONFLICT(dimension) DO UPDATE SET since_day = CASE WHEN COALESCE(clickhouse_sink_retry.since_day, '') = '' OR `+appRequestCreatedAtExpr("excluded.since_day")+` < `+appRequestCreatedAtExpr("clickhouse_sink_retry.since_day")+` THEN excluded.since_day ELSE clickhouse_sink_retry.since_day END, error = excluded.error, attempts = clickhouse_sink_retry.attempts + 1, last_attempt_at = excluded.last_attempt_at`),
		dimension, sinceDay, errMsg, now, now)
	return err
}

// ListClickHouseSinkState returns every dimension's watermark, newest success first.
func (s *SQLStore) ListClickHouseSinkState(ctx context.Context) ([]ClickHouseSinkState, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT dimension, COALESCE(last_synced_day,''), COALESCE(last_synced_id,''), COALESCE(last_success_at,''), COALESCE(rows_sent,0), COALESCE(updated_at,'')
		FROM clickhouse_sink_state ORDER BY last_success_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ClickHouseSinkState{}
	for rows.Next() {
		var st ClickHouseSinkState
		if err := rows.Scan(&st.Dimension, &st.LastSyncedDay, &st.LastSyncedID, &st.LastSuccessAt, &st.RowsSent, &st.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// ListClickHouseSinkRetries returns the pending retry queue, most attempts first.
func (s *SQLStore) ListClickHouseSinkRetries(ctx context.Context) ([]ClickHouseSinkRetry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT dimension, COALESCE(since_day,''), COALESCE(error,''), COALESCE(attempts,0), COALESCE(first_failed_at,''), COALESCE(last_attempt_at,'')
		FROM clickhouse_sink_retry ORDER BY attempts DESC, last_attempt_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ClickHouseSinkRetry{}
	for rows.Next() {
		var rt ClickHouseSinkRetry
		if err := rows.Scan(&rt.Dimension, &rt.SinceDay, &rt.Error, &rt.Attempts, &rt.FirstFailedAt, &rt.LastAttemptAt); err != nil {
			return nil, err
		}
		out = append(out, rt)
	}
	return out, rows.Err()
}

// ClickHouseSinkRetrySnapshot captures the failure generation before reading or
// sending rows. nil means no failure was queued at that instant.
func (s *SQLStore) ClickHouseSinkRetrySnapshot(ctx context.Context, dimension string) (*ClickHouseSinkRetry, error) {
	var out ClickHouseSinkRetry
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT dimension,COALESCE(since_day,''),COALESCE(error,''),COALESCE(attempts,0),COALESCE(first_failed_at,''),COALESCE(last_attempt_at,'') FROM clickhouse_sink_retry WHERE dimension = ?`), dimension).Scan(&out.Dimension, &out.SinceDay, &out.Error, &out.Attempts, &out.FirstFailedAt, &out.LastAttemptAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CompleteClickHouseSink records a fully sent interval and acknowledges only the
// failure observed before the attempt. An overlapping worker's newer failure is
// never deleted. No network request occurs inside this short transaction.
func (s *SQLStore) CompleteClickHouseSink(ctx context.Context, dimension, syncedDay string, rows int64, expected *ClickHouseSinkRetry) (bool, error) {
	return s.CompleteClickHouseSinkCursor(ctx, dimension, ClickHouseSinkCursor{Position: syncedDay}, rows, expected)
}

func (s *SQLStore) CompleteClickHouseSinkCursor(ctx context.Context, dimension string, cursor ClickHouseSinkCursor, rows int64, expected *ClickHouseSinkRetry) (bool, error) {
	if expected != nil && expected.Dimension != dimension {
		return false, errors.New("sink acknowledgement identity mismatch")
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	existingTime := appRequestCreatedAtExpr("COALESCE(clickhouse_sink_state.last_synced_day,'')")
	nextTime := appRequestCreatedAtExpr("excluded.last_synced_day")
	advance := nextTime + " > " + existingTime + " OR (" + nextTime + " = " + existingTime + " AND excluded.last_synced_id > COALESCE(clickhouse_sink_state.last_synced_id,''))"
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_sink_state (dimension,last_synced_day,last_synced_id,last_success_at,rows_sent,updated_at)
 VALUES (?,?,?,?,?,?) ON CONFLICT(dimension) DO UPDATE SET
 last_synced_day = CASE WHEN `+advance+` THEN excluded.last_synced_day ELSE clickhouse_sink_state.last_synced_day END,
 last_synced_id = CASE WHEN `+advance+` THEN excluded.last_synced_id ELSE COALESCE(clickhouse_sink_state.last_synced_id,'') END,
 last_success_at = excluded.last_success_at,rows_sent = excluded.rows_sent,updated_at = excluded.updated_at`), dimension, cursor.Position, cursor.ID, now, rows, now)
	if err != nil {
		return false, err
	}
	if expected != nil {
		_, err = tx.ExecContext(ctx, s.bind(`DELETE FROM clickhouse_sink_retry WHERE dimension = ? AND COALESCE(since_day,'') = ? AND COALESCE(error,'') = ? AND COALESCE(attempts,0) = ? AND COALESCE(first_failed_at,'') = ? AND COALESCE(last_attempt_at,'') = ?`), dimension, expected.SinceDay, expected.Error, expected.Attempts, expected.FirstFailedAt, expected.LastAttemptAt)
		if err != nil {
			return false, err
		}
	}
	var remaining int
	if err = tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM clickhouse_sink_retry WHERE dimension = ?`), dimension).Scan(&remaining); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		_ = tx.Rollback()
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, cleanupErr := conn.ExecContext(cleanup, "ROLLBACK"); cleanupErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		return false, err
	}
	return remaining == 0, nil
}
