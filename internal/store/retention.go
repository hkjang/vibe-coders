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
	conf    atomic.Pointer[config.RetentionConfig] // current config (swappable at runtime)
	reload  chan struct{}                          // signals the run loop to recreate its ticker
	done    chan struct{}
	wg      sync.WaitGroup
	lastRun atomic.Value // string RFC3339
	deleted atomic.Int64
}

func NewRetentionWorker(s *SQLStore, cfg config.RetentionConfig) *RetentionWorker {
	w := &RetentionWorker{store: s, done: make(chan struct{}), reload: make(chan struct{}, 1)}
	w.conf.Store(&cfg)
	w.lastRun.Store("")
	return w
}

func (w *RetentionWorker) curConf() config.RetentionConfig {
	if p := w.conf.Load(); p != nil {
		return *p
	}
	return config.RetentionConfig{}
}

// Reconfigure swaps the retention config at runtime. Day thresholds take effect on the
// next run; an interval change recreates the ticker. Safe to call from another goroutine.
func (w *RetentionWorker) Reconfigure(cfg config.RetentionConfig) {
	w.conf.Store(&cfg)
	select {
	case w.reload <- struct{}{}:
	default:
	}
}

func (w *RetentionWorker) Start() {
	if w.curConf().Interval <= 0 {
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
	interval := w.curConf().Interval
	if interval <= 0 {
		interval = time.Hour
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	w.runOnce()
	for {
		select {
		case <-t.C:
			w.runOnce()
		case <-w.reload:
			t.Stop()
			iv := w.curConf().Interval
			if iv <= 0 {
				iv = time.Hour
			}
			t = time.NewTicker(iv)
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
	cfg := w.curConf()
	// Roll up the last few days into analytics_daily BEFORE purging detailed logs,
	// so long-term aggregates survive retention even though the raw rows are gone.
	now := time.Now().UTC()
	if _, err := w.store.RollupRange(ctx, now.AddDate(0, 0, -3), now); err != nil {
		slog.Warn("retention rollup failed", "error", err)
		_ = w.store.InsertSystemError(ctx, "retention", "Retention rollup failed: "+err.Error())
	}

	var totalDeleted int64
	if cfg.PromptDays > 0 && (cfg.RequestDays <= 0 || cfg.PromptDays < cfg.RequestDays) {
		n, err := w.store.PurgeOlderThan(ctx, "prompt_logs", cfg.PromptDays)
		if err != nil {
			slog.Warn("retention purge prompt_logs failed", "error", err)
		}
		totalDeleted += n
	}
	if cfg.ResponseDays > 0 && (cfg.RequestDays <= 0 || cfg.ResponseDays < cfg.RequestDays) {
		n, err := w.store.PurgeOlderThan(ctx, "response_logs", cfg.ResponseDays)
		if err != nil {
			slog.Warn("retention purge response_logs failed", "error", err)
		}
		totalDeleted += n
	}
	if cfg.RequestDays > 0 {
		n, err := w.store.PurgeOlderThan(ctx, "request_logs", cfg.RequestDays)
		if err != nil {
			slog.Warn("retention purge request_logs failed", "error", err)
		}
		totalDeleted += n
	}
	if cfg.Text2SQLReplayDays > 0 {
		n, err := w.store.PurgeText2SQLReplayBundles(ctx, cfg.Text2SQLReplayDays)
		if err != nil {
			slog.Warn("retention purge text2sql_replay_bundles failed", "error", err)
		}
		totalDeleted += n
	}
	if n, err := w.store.PurgeChatSemanticExpired(ctx); err != nil {
		slog.Warn("retention purge chat_semantic_cache failed", "error", err)
	} else {
		totalDeleted += n
	}
	// Rows that are already treated as expired on read but were never deleted. These
	// grow with authentication traffic — refresh_tokens gains a row per rotation, not
	// per login — so left alone they outgrow the request logs beside them.
	const revokedGrace = 24 * time.Hour
	if n, err := w.store.PurgeExpiredRefreshTokens(ctx, revokedGrace); err != nil {
		slog.Warn("retention purge refresh_tokens failed", "error", err)
	} else {
		totalDeleted += n
	}
	if n, err := w.store.PurgeExpiredAuthSessions(ctx, revokedGrace); err != nil {
		slog.Warn("retention purge auth_sessions failed", "error", err)
	} else {
		totalDeleted += n
	}
	if n, err := w.store.PurgeExpiredText2SQLCache(ctx); err != nil {
		slog.Warn("retention purge text2sql_cache failed", "error", err)
	} else {
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
	return w.curConf()
}
