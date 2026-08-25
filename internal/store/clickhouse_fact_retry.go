package store

import (
	"context"
	"time"
)

// ClickHouseFactRetry is one failed fact-insert batch awaiting replay. The payload is the
// raw JSONEachRow body so reprocessing is a straight re-POST.
type ClickHouseFactRetry struct {
	ID        string `json:"id"`
	TableName string `json:"table_name"`
	Payload   string `json:"payload"`
	Rows      int    `json:"rows"`
	Error     string `json:"error"`
	Attempts  int    `json:"attempts"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// RecordClickHouseFactRetry persists a failed batch for later replay.
func (s *SQLStore) RecordClickHouseFactRetry(ctx context.Context, tableName, payload string, rows int, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_fact_retry (id, table_name, payload, rows, error, attempts, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 1, ?, ?)`),
		newStoreID("chfr"), tableName, payload, rows, errMsg, now, now)
	return err
}

// ListClickHouseFactRetries returns pending fact retry batches (oldest first), optionally
// filtered by table.
func (s *SQLStore) ListClickHouseFactRetries(ctx context.Context, tableName string, limit int) ([]ClickHouseFactRetry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := `SELECT id, table_name, payload, rows, COALESCE(error, ''), attempts, created_at, updated_at FROM clickhouse_fact_retry`
	args := []any{}
	if tableName != "" {
		q += " WHERE table_name = ?"
		args = append(args, tableName)
	}
	q += " ORDER BY created_at ASC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ClickHouseFactRetry{}
	for rows.Next() {
		var r ClickHouseFactRetry
		if err := rows.Scan(&r.ID, &r.TableName, &r.Payload, &r.Rows, &r.Error, &r.Attempts, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteClickHouseFactRetry removes a batch (after a successful replay).
func (s *SQLStore) DeleteClickHouseFactRetry(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM clickhouse_fact_retry WHERE id = ?`), id)
	return err
}

// CountClickHouseFactRetries returns the number of pending fact retry batches.
func (s *SQLStore) CountClickHouseFactRetries(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM clickhouse_fact_retry`).Scan(&n)
	return n, err
}
