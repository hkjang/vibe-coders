package proxy

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Detection windows for the scheduled sweep. They mirror the defaults the
// anomalies screen reads with, so what an operator sees and what gets recorded
// come from the same comparison.
const (
	anomalyBaselineWindow = 7 * 24 * time.Hour
	anomalyRecentWindow   = time.Hour
	anomalyZThreshold     = 3.0
)

// AnomalyWorker records cost and latency anomalies on a schedule.
//
// Recording used to happen inside GET /admin/anomalies, which made detection
// depend on somebody opening a dashboard and turned a read into something that
// wrote rows and fired webhooks. A gateway nobody is watching is exactly when
// anomalies matter, so the sweep runs here instead.
type AnomalyWorker struct {
	server   *Server
	interval time.Duration
	done     chan struct{}
	wg       sync.WaitGroup
}

func NewAnomalyWorker(server *Server, interval time.Duration) *AnomalyWorker {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &AnomalyWorker{server: server, interval: interval, done: make(chan struct{})}
}

func (w *AnomalyWorker) Start() {
	w.wg.Add(1)
	go w.run()
}

func (w *AnomalyWorker) Stop() {
	close(w.done)
	w.wg.Wait()
}

func (w *AnomalyWorker) run() {
	defer w.wg.Done()
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.sweep()
		case <-w.done:
			return
		}
	}
}

func (w *AnomalyWorker) sweep() {
	// The baseline query spans a week, so give it more room than the tick.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	inserted, err := w.server.sweepAnomalies(ctx, anomalyBaselineWindow, anomalyRecentWindow, anomalyZThreshold)
	if err != nil {
		slog.Warn("anomaly worker: sweep failed", "error", err)
		return
	}
	if len(inserted) > 0 {
		slog.Info("anomaly worker: recorded anomalies", "count", len(inserted))
	}
}
