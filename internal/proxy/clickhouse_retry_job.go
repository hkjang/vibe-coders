package proxy

import (
	"context"
	"time"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// Work outlives a browser connection but is bounded by the server lifecycle and
// a job deadline. Persisted leases make progress readable on another pod; a dead
// worker is reported as interrupted and is never automatically redispatched.
func (s *Server) runDwRetryJob(run store.ClickHouseSinkRun, cfg config.ClickHouseConfig, pending []store.ClickHouseSinkRetry, reason string) {
	ctx, cancel := context.WithTimeout(s.db.LifecycleContext(), 30*time.Minute)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				updateCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				err := s.db.UpdateClickHouseSinkRun(updateCtx, run.ID, run.WorkerToken, nil, time.Now().UTC())
				stop()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	persist := func() error {
		updateCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		return s.db.UpdateClickHouseSinkRun(updateCtx, run.ID, run.WorkerToken, &run.Progress, time.Now().UTC())
	}
	failed := false
	for i := range run.Progress.Dimensions {
		item := &run.Progress.Dimensions[i]
		if item.Status == "blocked" {
			failed = true
			run.Progress.FinishedDimensions++
			continue
		}
		if ctx.Err() != nil {
			failed = true
			break
		}
		item.Status = "running"
		if persist() != nil {
			failed = true
			cancel()
			break
		}
		var observed *store.ClickHouseSinkRetry
		for _, entry := range pending {
			if entry.Dimension == item.Dimension {
				copy := entry
				observed = &copy
				break
			}
		}
		before := run.Progress.SentRows
		interval := store.ClickHouseSinkRange{Dimension: item.Dimension, Since: item.Since, Until: item.Until}
		sent, err := s.sendClickHouseIntervalProgress(ctx, cfg, interval, observed, func(rows int) error {
			item.SentRows = int64(rows)
			run.Progress.SentRows = before + int64(rows)
			return persist()
		})
		item.SentRows = int64(sent)
		run.Progress.SentRows = before + int64(sent)
		item.Status = "succeeded"
		if err != nil {
			item.Status = "failed"
			item.Issue = "delivery_incomplete"
			failed = true
		} else {
			remaining, readErr := s.db.ClickHouseSinkRetrySnapshot(ctx, item.Dimension)
			if readErr != nil {
				item.Status = "failed"
				item.Issue = "completion_unconfirmed"
				failed = true
			} else if remaining != nil {
				item.Status = "pending"
				item.Issue = "new_failure_queued"
				failed = true
			}
		}
		run.Progress.FinishedDimensions++
		if persist() != nil {
			failed = true
			cancel()
			break
		}
	}
	for i := range run.Progress.Dimensions {
		item := &run.Progress.Dimensions[i]
		if item.Status == "queued" || item.Status == "running" {
			item.Status = "not_run"
			item.Issue = "operation_interrupted"
			failed = true
			run.Progress.FinishedDimensions++
		}
	}
	cancel()
	<-heartbeatDone
	run.Status = "succeeded"
	if failed {
		run.Status = "failed"
		if run.Progress.SentRows > 0 {
			run.Status = "partial_failed"
		}
	}
	run.FinishedAt = time.Now().UTC().Format(dwRetryTimeLayout)
	completeCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	// Completion status and its audit commit together. If recording fails, reads
	// show the last confirmed progress and eventually an interrupted lease, never
	// an invented success. The admission audit still identifies the attempted work.
	_ = s.db.FinishClickHouseSinkRun(completeCtx, run, store.AdminAuditLog{ID: run.ID + "_completed", AdminID: run.Actor, Action: "dw.clickhouse.retry.completed", BeforeValue: run.ID, AfterValue: auditJSON(map[string]any{"operation_id": run.ID, "reason": reason, "status": run.Status, "progress": run.Progress})})
}
