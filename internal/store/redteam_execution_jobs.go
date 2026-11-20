package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

var ErrRedTeamJobBusy = errors.New("another reviewed campaign job is active")
var ErrRedTeamJobLease = errors.New("reviewed campaign job lease is unavailable")
var errRedTeamJobExists = errors.New("reviewed campaign job already admitted")

const redTeamJobsTable = `CREATE TABLE IF NOT EXISTS redteam_execution_jobs (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, actor TEXT NOT NULL,
 worker_token TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL,
 definition_json TEXT NOT NULL, progress_json TEXT NOT NULL, outcome_json TEXT NOT NULL DEFAULT 'null'
)`

type RedTeamJobDefinition struct {
	ReviewID         string `json:"review_id"`
	Kind             string `json:"kind"`
	Reason           string `json:"reason"`
	PlannedLiveCalls int    `json:"planned_live_calls"`
	PlannedCases     int    `json:"planned_case_executions"`
}
type RedTeamJobProgress struct {
	RunIDs         []string `json:"run_ids"`
	LiveCalls      int      `json:"live_calls"`
	CompletedCases int      `json:"completed_cases"`
	CostKRW        float64  `json:"cost_krw"`
}
type RedTeamJob struct {
	RedTeamJobDefinition
	ID          string             `json:"id"`
	CampaignID  string             `json:"campaign_id"`
	Actor       string             `json:"-"`
	WorkerToken string             `json:"-"`
	LeaseUntil  string             `json:"-"`
	Status      string             `json:"status"`
	CreatedAt   string             `json:"created_at"`
	UpdatedAt   string             `json:"updated_at"`
	FinishedAt  string             `json:"finished_at"`
	Progress    RedTeamJobProgress `json:"progress"`
	Outcome     json.RawMessage    `json:"outcome"`
}

// Only the existing reviewed runner may dispatch an admitted job. Admission and
// its audit commit together, with cross-pool exclusion for the same campaign.
// No credentials, review capability, prompt or provider response is persisted.
func (s *SQLStore) AdmitRedTeamJob(ctx context.Context, job RedTeamJob, audit AdminAuditLog) (bool, error) {
	if job.ID == "" || job.CampaignID == "" || job.Actor == "" || job.WorkerToken == "" || job.ReviewID == "" || audit.AdminID != job.Actor || audit.Action != "redteam.job.requested" {
		return false, errors.New("invalid reviewed campaign admission")
	}
	definition, err := json.Marshal(job.RedTeamJobDefinition)
	if err != nil {
		return false, err
	}
	progress, err := json.Marshal(job.Progress)
	if err != nil {
		return false, err
	}
	err = s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		// Acquire a writer lock before reads on SQLite; PostgreSQL serializes the
		// campaign row, so unrelated campaigns do not share a global table lock.
		if s.dialect == "postgres" {
			var id string
			if err := tx.QueryRowContext(ctx, s.bind(`SELECT id FROM redteam_campaigns WHERE id = ? FOR UPDATE`), job.CampaignID).Scan(&id); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `UPDATE redteam_execution_jobs SET status = status WHERE 0`); err != nil {
				return err
			}
			var id string
			if err := tx.QueryRowContext(ctx, s.bind(`SELECT id FROM redteam_campaigns WHERE id = ?`), job.CampaignID).Scan(&id); err != nil {
				return err
			}
		}
		var count int
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM redteam_execution_jobs WHERE id = ?`), job.ID).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errRedTeamJobExists
		}
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM redteam_execution_jobs WHERE campaign_id = ? AND status = 'running' AND lease_until >= ?`), job.CampaignID, appRequestFixedTime(time.Now())).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return ErrRedTeamJobBusy
		}
		_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO redteam_execution_jobs (id,campaign_id,actor,worker_token,status,created_at,updated_at,finished_at,lease_until,definition_json,progress_json,outcome_json) VALUES (?,?,?,?,'running',?,?,'',?,?,?,'null')`), job.ID, job.CampaignID, job.Actor, job.WorkerToken, job.CreatedAt, job.UpdatedAt, job.LeaseUntil, string(definition), string(progress))
		return err
	})
	if errors.Is(err, errRedTeamJobExists) {
		return false, nil
	}
	return err == nil, err
}

func (s *SQLStore) RedTeamJob(ctx context.Context, id string) (RedTeamJob, bool, error) {
	var job RedTeamJob
	var definition, progress, outcome string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id,campaign_id,actor,worker_token,status,created_at,updated_at,finished_at,lease_until,definition_json,progress_json,outcome_json FROM redteam_execution_jobs WHERE id = ?`), id).Scan(&job.ID, &job.CampaignID, &job.Actor, &job.WorkerToken, &job.Status, &job.CreatedAt, &job.UpdatedAt, &job.FinishedAt, &job.LeaseUntil, &definition, &progress, &outcome)
	if errors.Is(err, sql.ErrNoRows) {
		return job, false, nil
	}
	if err != nil {
		return job, false, err
	}
	if err = json.Unmarshal([]byte(definition), &job.RedTeamJobDefinition); err != nil {
		return job, false, err
	}
	if err = json.Unmarshal([]byte(progress), &job.Progress); err != nil {
		return job, false, err
	}
	if !json.Valid([]byte(outcome)) {
		return job, false, errors.New("invalid recorded campaign outcome")
	}
	job.Outcome = json.RawMessage(outcome)
	return job, true, nil
}

// Every progress write and heartbeat is conditional on a still-current lease.
// Expired workers cannot revive themselves, nor overwrite a terminal result.
func (s *SQLStore) UpdateRedTeamJob(ctx context.Context, id, worker string, progress *RedTeamJobProgress, now time.Time) error {
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
	r, err := s.db.ExecContext(ctx, s.bind("UPDATE redteam_execution_jobs SET "+set+" WHERE id = ? AND worker_token = ? AND status = 'running' AND lease_until >= ?"), args...)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrRedTeamJobLease
	}
	return nil
}

func (s *SQLStore) FinishRedTeamJob(ctx context.Context, job RedTeamJob, audit AdminAuditLog) error {
	if (job.Status != "completed" && job.Status != "stopped" && job.Status != "unknown") || audit.AdminID != job.Actor || audit.Action != "redteam.job.completed" {
		return errors.New("invalid reviewed campaign completion")
	}
	progress, err := json.Marshal(job.Progress)
	if err != nil {
		return err
	}
	outcome := job.Outcome
	if len(outcome) == 0 {
		outcome = json.RawMessage("null")
	}
	if len(outcome) > 4<<20 || !json.Valid(outcome) {
		return errors.New("invalid reviewed campaign outcome")
	}
	return s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, s.bind(`UPDATE redteam_execution_jobs SET status=?,updated_at=?,finished_at=?,progress_json=?,outcome_json=? WHERE id=? AND worker_token=? AND status='running' AND lease_until>=?`), job.Status, job.FinishedAt, job.FinishedAt, string(progress), string(outcome), job.ID, job.WorkerToken, job.FinishedAt)
		if err != nil {
			return err
		}
		n, err := r.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrRedTeamJobLease
		}
		return nil
	})
}
