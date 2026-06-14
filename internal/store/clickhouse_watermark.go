package store

import (
	"context"
	"time"
)

// ClickHouseSinkState is the per-dimension watermark: the last day successfully
// shipped to ClickHouse and when. It lets operators see sink progress at a glance
// instead of inferring it from logs.
type ClickHouseSinkState struct {
	Dimension     string `json:"dimension"`
	LastSyncedDay string `json:"last_synced_day"`
	LastSuccessAt string `json:"last_success_at"`
	RowsSent      int64  `json:"rows_sent"`
	UpdatedAt     string `json:"updated_at"`
}

// ClickHouseSinkRetry is a persisted sink failure awaiting reprocessing. One row per
// dimension (the latest failure supersedes the previous), with an attempt counter.
type ClickHouseSinkRetry struct {
	Dimension     string `json:"dimension"`
	SinceDay      string `json:"since_day"`
	Error         string `json:"error"`
	Attempts      int64  `json:"attempts"`
	FirstFailedAt string `json:"first_failed_at"`
	LastAttemptAt string `json:"last_attempt_at"`
}

// RecordClickHouseSinkSuccess advances a dimension's watermark and clears any pending
// retry for it.
func (s *SQLStore) RecordClickHouseSinkSuccess(ctx context.Context, dimension, syncedDay string, rows int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_sink_state (dimension, last_synced_day, last_success_at, rows_sent, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(dimension) DO UPDATE SET last_synced_day = excluded.last_synced_day, last_success_at = excluded.last_success_at, rows_sent = excluded.rows_sent, updated_at = excluded.updated_at`),
		dimension, syncedDay, now, rows, now); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM clickhouse_sink_retry WHERE dimension = ?`), dimension)
	return err
}

// RecordClickHouseSinkFailure records (or bumps) a pending retry for a dimension.
func (s *SQLStore) RecordClickHouseSinkFailure(ctx context.Context, dimension, sinceDay, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_sink_retry (dimension, since_day, error, attempts, first_failed_at, last_attempt_at)
		VALUES (?, ?, ?, 1, ?, ?)
		ON CONFLICT(dimension) DO UPDATE SET since_day = excluded.since_day, error = excluded.error, attempts = clickhouse_sink_retry.attempts + 1, last_attempt_at = excluded.last_attempt_at`),
		dimension, sinceDay, errMsg, now, now)
	return err
}

// ListClickHouseSinkState returns every dimension's watermark, newest success first.
func (s *SQLStore) ListClickHouseSinkState(ctx context.Context) ([]ClickHouseSinkState, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT dimension, COALESCE(last_synced_day,''), COALESCE(last_success_at,''), COALESCE(rows_sent,0), COALESCE(updated_at,'')
		FROM clickhouse_sink_state ORDER BY last_success_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ClickHouseSinkState{}
	for rows.Next() {
		var st ClickHouseSinkState
		if err := rows.Scan(&st.Dimension, &st.LastSyncedDay, &st.LastSuccessAt, &st.RowsSent, &st.UpdatedAt); err != nil {
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
