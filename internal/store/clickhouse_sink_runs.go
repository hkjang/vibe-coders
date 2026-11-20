package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"time"
)

var ErrClickHouseSinkReviewConflict = errors.New("sink retry queue changed after review")
var ErrClickHouseSinkRunConflict = errors.New("sink retry run no longer owns its lease")
var ErrClickHouseSinkRunBusy = errors.New("another sink retry run is active")
var errClickHouseSinkRunExists = errors.New("sink retry review already admitted")

const clickHouseSinkRunsTable = `CREATE TABLE IF NOT EXISTS clickhouse_sink_runs (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, worker_token TEXT NOT NULL,
 status TEXT NOT NULL, reviewed_at TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
 lease_until TEXT NOT NULL, progress_json TEXT NOT NULL
)`

type ClickHouseSinkRunDimension struct {
	Dimension     string `json:"dimension"`
	Since         string `json:"since"`
	Until         string `json:"until"`
	EstimatedRows int64  `json:"estimated_rows"`
	SentRows      int64  `json:"sent_rows"`
	Status        string `json:"status"`
	Issue         string `json:"issue"`
}
type ClickHouseSinkRunProgress struct {
	EstimatedRows      int64                        `json:"estimated_rows"`
	SentRows           int64                        `json:"sent_rows"`
	FinishedDimensions int                          `json:"finished_dimensions"`
	Dimensions         []ClickHouseSinkRunDimension `json:"dimensions"`
}
type ClickHouseSinkRun struct {
	ID          string                    `json:"id"`
	Actor       string                    `json:"-"`
	WorkerToken string                    `json:"-"`
	LeaseUntil  string                    `json:"-"`
	Status      string                    `json:"status"`
	ReviewedAt  string                    `json:"reviewed_at"`
	CreatedAt   string                    `json:"created_at"`
	UpdatedAt   string                    `json:"updated_at"`
	FinishedAt  string                    `json:"finished_at"`
	Progress    ClickHouseSinkRunProgress `json:"progress"`
}

func sinkRetriesEqual(a, b []ClickHouseSinkRetry) bool {
	a = append([]ClickHouseSinkRetry{}, a...)
	b = append([]ClickHouseSinkRetry{}, b...)
	sort.Slice(a, func(i, j int) bool { return a[i].Dimension < a[j].Dimension })
	sort.Slice(b, func(i, j int) bool { return b[i].Dimension < b[j].Dimension })
	return reflect.DeepEqual(a, b)
}

// AdmitClickHouseSinkRun serializes queue validation, idempotent admission and
// its audit across pods. The transaction never includes a ClickHouse request.
func (s *SQLStore) AdmitClickHouseSinkRun(ctx context.Context, run ClickHouseSinkRun, expected []ClickHouseSinkRetry, audit AdminAuditLog) (bool, error) {
	if run.ID == "" || run.Actor == "" || run.WorkerToken == "" || audit.Action != "dw.clickhouse.retry.requested" || audit.AdminID != run.Actor {
		return false, errors.New("invalid sink run admission")
	}
	progress, err := json.Marshal(run.Progress)
	if err != nil {
		return false, err
	}
	err = s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		lock := `UPDATE clickhouse_sink_retry SET attempts = attempts WHERE 0`
		if s.dialect == "postgres" {
			lock = `LOCK TABLE clickhouse_sink_retry IN SHARE ROW EXCLUSIVE MODE`
		}
		if _, err := tx.ExecContext(ctx, lock); err != nil {
			return err
		}
		var existing int
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM clickhouse_sink_runs WHERE id = ?`), run.ID).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return errClickHouseSinkRunExists
		}
		// Different browser reviews must not dispatch the same pending interval
		// concurrently. The queue lock serializes admission across server pools.
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM clickhouse_sink_runs WHERE status = 'running' AND lease_until >= ?`), appRequestFixedTime(time.Now())).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return ErrClickHouseSinkRunBusy
		}
		rows, err := tx.QueryContext(ctx, `SELECT dimension,COALESCE(since_day,''),COALESCE(error,''),COALESCE(attempts,0),COALESCE(first_failed_at,''),COALESCE(last_attempt_at,'') FROM clickhouse_sink_retry`)
		if err != nil {
			return err
		}
		current := []ClickHouseSinkRetry{}
		for rows.Next() {
			var item ClickHouseSinkRetry
			if err := rows.Scan(&item.Dimension, &item.SinceDay, &item.Error, &item.Attempts, &item.FirstFailedAt, &item.LastAttemptAt); err != nil {
				rows.Close()
				return err
			}
			current = append(current, item)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if !sinkRetriesEqual(current, expected) {
			return ErrClickHouseSinkReviewConflict
		}
		result, err := tx.ExecContext(ctx, s.bind(`INSERT INTO clickhouse_sink_runs (id,actor,worker_token,status,reviewed_at,created_at,updated_at,finished_at,lease_until,progress_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`), run.ID, run.Actor, run.WorkerToken, "running", run.ReviewedAt, run.CreatedAt, run.UpdatedAt, "", run.LeaseUntil, string(progress))
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return errClickHouseSinkRunExists
		}
		return nil
	})
	if errors.Is(err, errClickHouseSinkRunExists) {
		return false, nil
	}
	return err == nil, err
}

func (s *SQLStore) ClickHouseSinkRun(ctx context.Context, id string) (ClickHouseSinkRun, bool, error) {
	var run ClickHouseSinkRun
	var progress string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id,actor,worker_token,status,reviewed_at,created_at,updated_at,finished_at,lease_until,progress_json FROM clickhouse_sink_runs WHERE id = ?`), id).Scan(&run.ID, &run.Actor, &run.WorkerToken, &run.Status, &run.ReviewedAt, &run.CreatedAt, &run.UpdatedAt, &run.FinishedAt, &run.LeaseUntil, &progress)
	if errors.Is(err, sql.ErrNoRows) {
		return run, false, nil
	}
	if err != nil {
		return run, false, err
	}
	if err = json.Unmarshal([]byte(progress), &run.Progress); err != nil {
		return run, false, err
	}
	return run, true, nil
}

// Heartbeat and progress writes cannot revive an expired or replaced worker.
func (s *SQLStore) UpdateClickHouseSinkRun(ctx context.Context, id, worker string, progress *ClickHouseSinkRunProgress, now time.Time) error {
	args := []any{appRequestFixedTime(now), appRequestFixedTime(now.Add(90 * time.Second))}
	set := "updated_at = ?, lease_until = ?"
	if progress != nil {
		raw, err := json.Marshal(progress)
		if err != nil {
			return err
		}
		set += ", progress_json = ?"
		args = append(args, string(raw))
	}
	args = append(args, id, worker, appRequestFixedTime(now))
	result, err := s.db.ExecContext(ctx, s.bind("UPDATE clickhouse_sink_runs SET "+set+" WHERE id = ? AND worker_token = ? AND status = 'running' AND lease_until >= ?"), args...)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrClickHouseSinkRunConflict
	}
	return nil
}

func (s *SQLStore) FinishClickHouseSinkRun(ctx context.Context, run ClickHouseSinkRun, audit AdminAuditLog) error {
	if run.Status != "succeeded" && run.Status != "partial_failed" && run.Status != "failed" {
		return errors.New("invalid sink run terminal state")
	}
	if audit.Action != "dw.clickhouse.retry.completed" || audit.AdminID != run.Actor {
		return errors.New("invalid sink run completion audit")
	}
	progress, err := json.Marshal(run.Progress)
	if err != nil {
		return err
	}
	return s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.bind(`UPDATE clickhouse_sink_runs SET status = ?,progress_json = ?,updated_at = ?,finished_at = ? WHERE id = ? AND worker_token = ? AND status = 'running' AND lease_until >= ?`), run.Status, string(progress), run.FinishedAt, run.FinishedAt, run.ID, run.WorkerToken, run.FinishedAt)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrClickHouseSinkRunConflict
		}
		return nil
	})
}
