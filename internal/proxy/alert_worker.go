package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

type AlertWorker struct {
	db       *store.SQLStore
	metrics  *Metrics
	interval time.Duration
	client   *http.Client
	done     chan struct{}
	wg       sync.WaitGroup
}

func NewAlertWorker(db *store.SQLStore, metrics *Metrics, interval time.Duration) *AlertWorker {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	return &AlertWorker{
		db:       db,
		metrics:  metrics,
		interval: interval,
		client:   &http.Client{Timeout: 10 * time.Second},
		done:     make(chan struct{}),
	}
}

func (w *AlertWorker) Start() {
	w.wg.Add(1)
	go w.run()
}

func (w *AlertWorker) Stop() {
	close(w.done)
	w.wg.Wait()
}

func (w *AlertWorker) run() {
	defer w.wg.Done()
	t := time.NewTicker(w.interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			w.evaluate()
		case <-w.done:
			return
		}
	}
}

func (w *AlertWorker) evaluate() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rules, err := w.db.ListAlertRules(ctx)
	if err != nil {
		slog.Warn("alert worker: list rules failed", "error", err)
		return
	}
	now := time.Now()
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		// debounce: don't refire within window after last fire
		if rule.LastFiredAt != nil && now.Sub(*rule.LastFiredAt) < time.Duration(rule.WindowSeconds)*time.Second {
			continue
		}
		since := now.Add(-time.Duration(rule.WindowSeconds) * time.Second)
		snapshot, err := w.db.MetricSince(ctx, rule.Scope, rule.ScopeValue, since)
		if err != nil {
			slog.Warn("alert worker: metric query failed", "rule", rule.Name, "error", err)
			continue
		}
		value := metricValue(rule.Metric, snapshot)
		if value < rule.Threshold {
			continue
		}
		w.fire(ctx, rule, value)
	}
}

func metricValue(metric string, snapshot store.AlertMetricSnapshot) float64 {
	switch metric {
	case "requests":
		return float64(snapshot.Requests)
	case "errors":
		if snapshot.Requests == 0 {
			return 0
		}
		return float64(snapshot.Errors) / float64(snapshot.Requests)
	case "krw":
		return snapshot.CostKRW
	case "tokens":
		return float64(snapshot.Tokens)
	case "latency_p95_ms":
		return snapshot.LatencyP95MS
	case "first_chunk_p95_ms":
		return snapshot.FirstChunkP95MS
	case "llm_eval_failures":
		return float64(snapshot.LLMEvalFailures)
	case "llm_eval_failure_rate":
		if snapshot.LLMEvaluations == 0 {
			return 0
		}
		return float64(snapshot.LLMEvalFailures) / float64(snapshot.LLMEvaluations)
	case "tool_errors":
		return float64(snapshot.ToolErrors)
	case "tool_error_rate":
		if snapshot.ToolCalls == 0 {
			return 0
		}
		return float64(snapshot.ToolErrors) / float64(snapshot.ToolCalls)
	case "tool_loop":
		return float64(snapshot.MaxSessionToolCall)
	case "mcp_new_tools":
		return float64(snapshot.NewCatalogTools)
	case "anomaly_zmax":
		return snapshot.MaxAnomalyZ
	}
	return 0
}

func (w *AlertWorker) fire(ctx context.Context, rule store.AlertRule, value float64) {
	now := time.Now().UTC()
	w.metrics.IncAlertFired()
	event := store.AlertEvent{
		ID:        newID("alertev"),
		RuleID:    rule.ID,
		RuleName:  rule.Name,
		Metric:    rule.Metric,
		Value:     value,
		Threshold: rule.Threshold,
		CreatedAt: now,
	}
	if rule.WebhookURL != "" {
		if err := w.postWebhook(ctx, rule, value); err != nil {
			event.DeliveryError = err.Error()
		} else {
			event.Delivered = true
			w.metrics.IncAlertDelivered()
		}
	}
	if err := w.db.InsertAlertEvent(ctx, event); err != nil {
		slog.Warn("alert worker: insert event failed", "rule", rule.Name, "error", err)
	}
	if err := w.db.UpdateAlertFireState(ctx, rule.ID, value, now); err != nil {
		slog.Warn("alert worker: update fire state failed", "rule", rule.Name, "error", err)
	}
}

func (w *AlertWorker) postWebhook(ctx context.Context, rule store.AlertRule, value float64) error {
	text := fmt.Sprintf("[AI 코딩 프록시 알림] 규칙 %q 임계치 도달: %s = %s (>= %s, 윈도우 %ds, 대상 %s/%s)",
		rule.Name, rule.Metric, formatMetricValue(rule.Metric, value),
		formatMetricValue(rule.Metric, rule.Threshold), rule.WindowSeconds, rule.Scope, rule.ScopeValue)
	body, _ := json.Marshal(map[string]any{
		"text":           text,
		"rule":           rule.Name,
		"metric":         rule.Metric,
		"value":          value,
		"threshold":      rule.Threshold,
		"window_seconds": rule.WindowSeconds,
		"scope":          rule.Scope,
		"scope_value":    rule.ScopeValue,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rule.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}

func formatMetricValue(metric string, value float64) string {
	switch metric {
	case "krw":
		return fmt.Sprintf("₩%.0f", value)
	case "errors", "llm_eval_failure_rate", "tool_error_rate":
		return fmt.Sprintf("%.1f%%", value*100)
	case "llm_eval_failures":
		return fmt.Sprintf("%.0f failures", value)
	case "latency_p95_ms", "first_chunk_p95_ms":
		return fmt.Sprintf("%.0f ms", value)
	default:
		return fmt.Sprintf("%.0f", value)
	}
}
