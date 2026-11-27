package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"vibe-coders/internal/workintel"
)

// ---- Classification cache ----

// WorkClassCacheEntry is a stored result of the semantic step.
type WorkClassCacheEntry struct {
	Key             string   `json:"key"`
	PolicyVersion   int      `json:"policy_version"`
	Team            string   `json:"team"`
	CategoryID      string   `json:"category_id"`
	ActionType      string   `json:"action_type"`
	Confidence      float64  `json:"confidence"`
	Status          string   `json:"status"`
	Tags            []string `json:"tags"`
	Technologies    []string `json:"technologies"`
	TargetSystem    string   `json:"target_system"`
	WorkTitle       string   `json:"work_title"`
	NewCategoryHint string   `json:"new_category_hint"`
	ClassifierModel string   `json:"classifier_model"`
	Hits            int64    `json:"hits"`
	CreatedAt       string   `json:"created_at"`
}

// WorkClassCacheKey derives the cache key for a prompt fingerprint. The team
// is part of the digest, so one team's result is never served to another, and
// so is the policy version, so a published change starts from an empty cache.
// The parts are separated by a byte no team name or fingerprint can hold, so
// two different triples never produce the same input.
func WorkClassCacheKey(policyVersion int, team, fingerprint string) string {
	sum := sha256.Sum256([]byte(strconv.Itoa(policyVersion) + "\x00" + team + "\x00" + fingerprint))
	return hex.EncodeToString(sum[:])
}

// Result returns the cached classification as an engine result with method
// "cache".
func (e WorkClassCacheEntry) Result() workintel.Result {
	return workintel.Result{
		CategoryID:      e.CategoryID,
		TopCategoryID:   workTopCategory(e.CategoryID),
		ActionType:      e.ActionType,
		Confidence:      e.Confidence,
		Method:          workintel.MethodCache,
		Status:          e.Status,
		Tags:            e.Tags,
		Technologies:    e.Technologies,
		TargetSystem:    e.TargetSystem,
		WorkTitle:       e.WorkTitle,
		NewCategoryHint: e.NewCategoryHint,
		Candidates:      []workintel.Candidate{},
	}
}

// GetWorkClassCache looks up cache keys and returns the entries found, by key.
func (s *SQLStore) GetWorkClassCache(ctx context.Context, keys []string) (map[string]WorkClassCacheEntry, error) {
	out := map[string]WorkClassCacheEntry{}
	for _, chunk := range workChunks(keys, WorkIntelMaxBatch) {
		rows, err := s.db.QueryContext(ctx, s.bind(`SELECT cache_key, policy_version, team, category_id, action_type, confidence, status,
				tags, technologies, target_system, work_title, new_category_hint, classifier_model, hits, created_at
			FROM work_class_cache WHERE cache_key IN (`+placeholders(len(chunk))+`)`), workAnyArgs(chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var e WorkClassCacheEntry
			var tags, techs string
			if err := rows.Scan(&e.Key, &e.PolicyVersion, &e.Team, &e.CategoryID, &e.ActionType, &e.Confidence, &e.Status,
				&tags, &techs, &e.TargetSystem, &e.WorkTitle, &e.NewCategoryHint, &e.ClassifierModel, &e.Hits, &e.CreatedAt); err != nil {
				rows.Close()
				return nil, err
			}
			e.Tags, e.Technologies = decodeList(tags), decodeList(techs)
			out[e.Key] = e
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// PutWorkClassCache stores results of the semantic step. An existing entry is
// kept: the first answer for a fingerprint stays the answer, so requests
// classified a minute apart do not disagree.
func (s *SQLStore) PutWorkClassCache(ctx context.Context, entries []WorkClassCacheEntry) error {
	args := make([]any, 0, len(entries)*14)
	now := workIntelTime(time.Now())
	for _, e := range entries {
		if e.Key == "" {
			continue
		}
		args = append(args, e.Key, e.PolicyVersion, e.Team, e.CategoryID, e.ActionType, e.Confidence, e.Status,
			workEncodeList(e.Tags), workEncodeList(e.Technologies), e.TargetSystem, e.WorkTitle, e.NewCategoryHint, e.ClassifierModel, now)
	}
	_, err := s.workBatchExec(ctx, s.db, `INSERT INTO work_class_cache (cache_key, policy_version, team, category_id, action_type,
		confidence, status, tags, technologies, target_system, work_title, new_category_hint, classifier_model, created_at)`,
		workRowPlaceholder(14), `ON CONFLICT(cache_key) DO NOTHING`, 14, args)
	return err
}

// TouchWorkClassCache adds to the hit counters of the given keys.
func (s *SQLStore) TouchWorkClassCache(ctx context.Context, hits map[string]int) error {
	now := workIntelTime(time.Now())
	for key, n := range hits {
		if n <= 0 {
			continue
		}
		if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_class_cache SET hits = hits + ?, last_hit_at = ? WHERE cache_key = ?`), n, now, key); err != nil {
			return err
		}
	}
	return nil
}

// PurgeWorkClassCache deletes the entries of policy versions older than
// keepFromVersion. Their keys can never be asked for again.
func (s *SQLStore) PurgeWorkClassCache(ctx context.Context, keepFromVersion int) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM work_class_cache WHERE policy_version < ?`), keepFromVersion)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---- Jobs ----

// Work intel job states. "interrupted" is never stored: it is how a job reads
// when it is still marked running but its worker stopped renewing the lease.
const (
	WorkJobQueued      = "queued"
	WorkJobRunning     = "running"
	WorkJobSucceeded   = "succeeded"
	WorkJobFailed      = "failed"
	WorkJobInterrupted = "interrupted"

	// workJobLease is how long a job stays owned without a heartbeat.
	workJobLease = 90 * time.Second
)

// WorkIntelJobProgress is the progress document of a reclassification job.
type WorkIntelJobProgress struct {
	Total       int64  `json:"total"`
	Done        int64  `json:"done"`
	Changed     int64  `json:"changed"`
	Failed      int64  `json:"failed"`
	DaysRebuilt int    `json:"days_rebuilt"`
	Cursor      string `json:"cursor"`
	// KeptNoText counts requests whose prompt text is no longer stored (prompts
	// are kept for a shorter time than requests). Classifying them again without
	// the text would turn a good classification into "unclassified", so they
	// keep the one they have.
	KeptNoText int64 `json:"kept_no_text"`
	// Previewed is how many requests the reviewed preview counted. The job
	// counts its selection again when it is confirmed (Total); the two differ
	// when the worker classified some of the selected requests in between.
	Previewed int64 `json:"previewed"`
}

// WorkIntelJob is one administrator job.
type WorkIntelJob struct {
	ID          string               `json:"id"`
	Kind        string               `json:"kind"`
	Status      string               `json:"status"`
	Actor       string               `json:"actor"`
	WorkerToken string               `json:"-"`
	LeaseUntil  string               `json:"-"`
	ParamsJSON  string               `json:"-"`
	Progress    WorkIntelJobProgress `json:"progress"`
	Error       string               `json:"error,omitempty"`
	CreatedAt   string               `json:"created_at"`
	UpdatedAt   string               `json:"updated_at"`
	FinishedAt  string               `json:"finished_at,omitempty"`
}

// AdmitWorkIntelJob starts a job unless one is already active, and writes its
// audit row in the same transaction. The id is chosen by the caller and
// should be derived from what was reviewed: admitting the same id twice
// reports false without error and starts nothing, so a repeated confirmation
// cannot run the job twice. A different job while one is queued or running
// (and its lease is alive) is refused with ErrWorkIntelJobActive.
func (s *SQLStore) AdmitWorkIntelJob(ctx context.Context, job WorkIntelJob, audit AdminAuditLog) (bool, error) {
	if job.ID == "" || job.Kind == "" || job.WorkerToken == "" {
		return false, errors.New("invalid work intel job admission")
	}
	progress, err := json.Marshal(job.Progress)
	if err != nil {
		return false, err
	}
	if job.ParamsJSON == "" {
		job.ParamsJSON = "{}"
	}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return false, err
	}
	admitted := false
	err = s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		// The state row lock serializes admissions across instances.
		if err := s.lockWorkIntelTx(ctx, tx); err != nil {
			return err
		}
		var existing int
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM work_intel_jobs WHERE id = ?`), job.ID).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return errWorkIntelJobExists
		}
		now := time.Now()
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM work_intel_jobs
			WHERE status IN ('queued', 'running') AND lease_until >= ?`), workIntelTime(now)).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return ErrWorkIntelJobActive
		}
		stamp := workIntelTime(now)
		_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO work_intel_jobs
			(id, kind, status, actor, worker_token, lease_until, params_json, progress_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), cleanArgs([]any{job.ID, job.Kind, WorkJobRunning, job.Actor, job.WorkerToken,
			workIntelTime(now.Add(workJobLease)), job.ParamsJSON, string(progress), stamp, stamp})...)
		if err == nil {
			admitted = true
		}
		return err
	})
	if errors.Is(err, errWorkIntelJobExists) {
		return false, nil
	}
	return admitted && err == nil, err
}

var errWorkIntelJobExists = errors.New("work intel job already admitted")

// UpdateWorkIntelJob renews the lease of a running job and, when progress is
// not nil, stores it. A worker that lost the job (expired lease taken over,
// or the job finished) gets ErrWorkIntelJobConflict and must stop.
func (s *SQLStore) UpdateWorkIntelJob(ctx context.Context, id, workerToken string, progress *WorkIntelJobProgress) error {
	now := time.Now()
	set := "updated_at = ?, lease_until = ?"
	args := []any{workIntelTime(now), workIntelTime(now.Add(workJobLease))}
	if progress != nil {
		raw, err := json.Marshal(progress)
		if err != nil {
			return err
		}
		set += ", progress_json = ?"
		args = append(args, string(raw))
	}
	args = append(args, id, workerToken, WorkJobRunning, workIntelTime(now))
	res, err := s.db.ExecContext(ctx, s.bind("UPDATE work_intel_jobs SET "+set+" WHERE id = ? AND worker_token = ? AND status = ? AND lease_until >= ?"), args...)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return ErrWorkIntelJobConflict
	}
	return nil
}

// FinishWorkIntelJob ends a job the worker still owns with a terminal status
// ("succeeded" or "failed"), its final progress and an optional error text.
func (s *SQLStore) FinishWorkIntelJob(ctx context.Context, id, workerToken, status string, progress WorkIntelJobProgress, errText string) error {
	if status != WorkJobSucceeded && status != WorkJobFailed {
		return errors.New("invalid work intel job terminal state")
	}
	raw, err := json.Marshal(progress)
	if err != nil {
		return err
	}
	now := workIntelTime(time.Now())
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_jobs SET status = ?, progress_json = ?, error = ?, updated_at = ?, finished_at = ?, lease_until = ''
		WHERE id = ? AND worker_token = ? AND status = ?`), cleanArgs([]any{status, string(raw), errText, now, now, id, workerToken, WorkJobRunning})...)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return ErrWorkIntelJobConflict
	}
	return nil
}

const workIntelJobColumns = `id, kind, status, actor, worker_token, lease_until, params_json, progress_json, error, created_at, updated_at, finished_at`

func scanWorkIntelJob(row workRowScanner, now time.Time) (WorkIntelJob, error) {
	var job WorkIntelJob
	var progress string
	if err := row.Scan(&job.ID, &job.Kind, &job.Status, &job.Actor, &job.WorkerToken, &job.LeaseUntil, &job.ParamsJSON, &progress,
		&job.Error, &job.CreatedAt, &job.UpdatedAt, &job.FinishedAt); err != nil {
		return job, err
	}
	_ = json.Unmarshal([]byte(progress), &job.Progress)
	// A job nobody is renewing did not finish; say so instead of showing it as
	// running forever.
	if (job.Status == WorkJobRunning || job.Status == WorkJobQueued) && job.LeaseUntil < workIntelTime(now) {
		job.Status = WorkJobInterrupted
	}
	return job, nil
}

// GetWorkIntelJob returns one job.
func (s *SQLStore) GetWorkIntelJob(ctx context.Context, id string) (WorkIntelJob, bool, error) {
	job, err := scanWorkIntelJob(s.db.QueryRowContext(ctx, s.bind(`SELECT `+workIntelJobColumns+` FROM work_intel_jobs WHERE id = ?`), id), time.Now())
	if errors.Is(err, sql.ErrNoRows) {
		return WorkIntelJob{}, false, nil
	}
	return job, err == nil, err
}

// ActiveWorkIntelJob returns the job that is queued or running with a live
// lease, if there is one.
func (s *SQLStore) ActiveWorkIntelJob(ctx context.Context) (WorkIntelJob, bool, error) {
	now := time.Now()
	job, err := scanWorkIntelJob(s.db.QueryRowContext(ctx, s.bind(`SELECT `+workIntelJobColumns+` FROM work_intel_jobs
		WHERE status IN ('queued', 'running') AND lease_until >= ? ORDER BY created_at DESC LIMIT 1`), workIntelTime(now)), now)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkIntelJob{}, false, nil
	}
	return job, err == nil, err
}
