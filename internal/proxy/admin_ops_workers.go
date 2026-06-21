package proxy

import (
	"net/http"
)

// workerStatus is one background worker's observable health.
type workerStatus struct {
	Name       string `json:"name"`
	Running    bool   `json:"running"`
	Status     string `json:"status"` // ok | warn | critical | idle
	QueueDepth int    `json:"queue_depth"`
	Capacity   int    `json:"capacity"`
	Dropped    int64  `json:"dropped"`
	LastRun    string `json:"last_run,omitempty"`
	Detail     string `json:"detail"`
}

// handleOpsWorkers reports the runtime state of the gateway's background workers (async logger,
// per-request fact ingest queue, ClickHouse sink, fact-retry backlog, retention). Read-only.
// GET /admin/ops/workers
func (s *Server) handleOpsWorkers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	workers := []workerStatus{}

	// Async request logger.
	if s.logger != nil {
		depth := s.logger.QueueDepth()
		dropped := int64(s.logger.Dropped())
		ws := workerStatus{Name: "async_logger", Running: true, Status: "ok", QueueDepth: depth, Dropped: dropped,
			Detail: "written=" + itoaProxy(int(s.logger.Written()))}
		if dropped > 0 {
			ws.Status = "warn"
		}
		if depth > 5000 {
			ws.Status = "critical"
		}
		workers = append(workers, ws)
	}

	// Per-request fact ingest queue (feeds the ClickHouse fact loop).
	if s.chFactQueue != nil {
		depth, capn := len(s.chFactQueue), cap(s.chFactQueue)
		dropped := s.chFactDropped.Load()
		ws := workerStatus{Name: "clickhouse_fact_queue", Running: true, Status: "ok", QueueDepth: depth, Capacity: capn, Dropped: dropped,
			Detail: "per-request fact ingest"}
		if dropped > 0 {
			ws.Status = "warn"
		}
		if capn > 0 && depth >= capn*9/10 {
			ws.Status = "critical"
			ws.Detail = "queue near capacity"
		}
		workers = append(workers, ws)
	}

	// ClickHouse rollup sink worker (managed lifecycle).
	ch := s.chConf()
	s.chSinkMu.Lock()
	sinkRunning := s.chSinkStop != nil
	sinkStarted := s.chSinkStarted
	s.chSinkMu.Unlock()
	sink := workerStatus{Name: "clickhouse_sink", Running: sinkRunning, Status: "idle", Detail: "ClickHouse rollup sink"}
	switch {
	case ch.URL == "":
		sink.Detail = "ClickHouse 미설정"
	case sinkRunning:
		sink.Status = "ok"
		sink.Detail = "rollup sink 실행 중"
	case sinkStarted:
		sink.Status = "warn"
		sink.Detail = "설정됐으나 sink 미실행 (interval/URL 확인)"
	}
	workers = append(workers, sink)

	// Fact-retry backlog (failed inserts awaiting retry).
	if ch.URL != "" {
		retry := workerStatus{Name: "clickhouse_fact_retry", Running: true, Status: "ok", Detail: "재시도 대기 fact 배치"}
		if n, err := s.db.CountClickHouseFactRetries(r.Context()); err == nil {
			retry.QueueDepth = n
			if n > 0 {
				retry.Status = "warn"
			}
			if n >= 50 {
				retry.Status = "critical"
			}
		} else {
			retry.Status, retry.Detail = "warn", "백로그 조회 실패"
		}
		workers = append(workers, retry)
	}

	// Retention worker.
	if s.retention != nil {
		cfg := s.retention.Config()
		ws := workerStatus{Name: "retention", Running: cfg.Interval > 0, Status: "ok", LastRun: s.retention.LastRun(),
			Detail: "interval=" + cfg.Interval.String() + " requests=" + itoaProxy(cfg.RequestDays) + "d"}
		if cfg.Interval <= 0 {
			ws.Status, ws.Detail = "idle", "보존 주기 비활성(Interval=0)"
		}
		workers = append(workers, ws)
	}

	// Text2SQL saved-report scheduler (self-disables without an execute DB).
	workers = append(workers, workerStatus{Name: "text2sql_report_scheduler", Running: true, Status: "ok",
		Detail: "저장 리포트 스케줄러(실행 DB 없으면 자동 무력화)"})

	overall := "ok"
	for _, ws := range workers {
		overall = worseStatus(overall, ws.Status)
	}
	writeJSON(w, http.StatusOK, map[string]any{"overall": overall, "workers": workers})
}
