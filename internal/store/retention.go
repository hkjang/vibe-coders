package store

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"vibe-coders/internal/config"
)

type RetentionWorker struct {
	store   *SQLStore
	cfg     config.RetentionConfig
	done    chan struct{}
	wg      sync.WaitGroup
	lastRun atomic.Value // string RFC3339
	deleted atomic.Int64
}

func NewRetentionWorker(s *SQLStore, cfg config.RetentionConfig) *RetentionWorker {
	w := &RetentionWorker{store: s, cfg: cfg, done: make(chan struct{})}
	w.lastRun.Store("")
	return w
}

func (w *RetentionWorker) Start() {
	if w.cfg.Interval <= 0 {
		return
	}
	w.wg.Add(1)
	go w.run()
}

func (w *RetentionWorker) Stop() {
	close(w.done)
	w.wg.Wait()
}

func (w *RetentionWorker) run() {
	defer w.wg.Done()
	t := time.NewTicker(w.cfg.Interval)
	defer t.Stop()
	w.runOnce()
	for {
		select {
		case <-t.C:
			w.runOnce()
		case <-w.done:
			return
		}
	}
}

func (w *RetentionWorker) RunOnce(ctx context.Context) int64 {
	return w.runOnceWith(ctx)
}

func (w *RetentionWorker) runOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	w.runOnceWith(ctx)
}

func (w *RetentionWorker) runOnceWith(ctx context.Context) int64 {
	var totalDeleted int64
	if w.cfg.PromptDays > 0 && (w.cfg.RequestDays <= 0 || w.cfg.PromptDays < w.cfg.RequestDays) {
		n, err := w.store.PurgeOlderThan(ctx, "prompt_logs", w.cfg.PromptDays)
		if err != nil {
			slog.Warn("retention purge prompt_logs failed", "error", err)
		}
		totalDeleted += n
	}
	if w.cfg.ResponseDays > 0 && (w.cfg.RequestDays <= 0 || w.cfg.ResponseDays < w.cfg.RequestDays) {
		n, err := w.store.PurgeOlderThan(ctx, "response_logs", w.cfg.ResponseDays)
		if err != nil {
			slog.Warn("retention purge response_logs failed", "error", err)
		}
		totalDeleted += n
	}
	if w.cfg.RequestDays > 0 {
		n, err := w.store.PurgeOlderThan(ctx, "request_logs", w.cfg.RequestDays)
		if err != nil {
			slog.Warn("retention purge request_logs failed", "error", err)
		}
		totalDeleted += n
	}
	w.deleted.Add(totalDeleted)
	w.lastRun.Store(time.Now().UTC().Format(time.RFC3339))
	return totalDeleted
}

func (w *RetentionWorker) LastRun() string {
	if v, ok := w.lastRun.Load().(string); ok {
		return v
	}
	return ""
}

func (w *RetentionWorker) TotalDeleted() int64 {
	return w.deleted.Load()
}

func (w *RetentionWorker) Config() config.RetentionConfig {
	return w.cfg
}
