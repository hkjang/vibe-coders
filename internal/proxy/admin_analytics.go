package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleTimeseries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	bucket := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("bucket")))
	if bucket != "day" {
		bucket = "hour"
	}
	since := parseWindow(r.URL.Query().Get("window"), 24*time.Hour, bucket)
	q := store.TimeseriesQuery{
		Bucket:     bucket,
		Since:      since,
		Scope:      strings.TrimSpace(r.URL.Query().Get("scope")),
		ScopeValue: strings.TrimSpace(r.URL.Query().Get("value")),
	}
	points, err := s.db.Timeseries(r.Context(), q)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "timeseries_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bucket": bucket,
		"since":  since.UTC().Format(time.RFC3339),
		"points": points,
	})
}

func (s *Server) handleScatter(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), time.Hour, "hour")
	limit := 5000
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	// Multi-model filter: ?models=gpt-4.1,gpt-4.1-mini takes precedence over ?model=
	models := parseModelsParam(r.URL.Query().Get("models"))
	singleModel := strings.TrimSpace(r.URL.Query().Get("model"))

	f := store.ScatterFilter{
		Since:    since,
		Endpoint: strings.TrimSpace(r.URL.Query().Get("endpoint")),
		APIKeyID: strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		Limit:    limit,
	}
	if len(models) > 0 {
		f.Models = models
	} else {
		f.Model = singleModel
	}

	points, truncated, err := s.db.ScatterPoints(r.Context(), f)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "scatter_failed")
		return
	}

	resp := map[string]any{
		"points":    points,
		"truncated": truncated,
		"since":     since.UTC().Format(time.RFC3339),
	}

	// include per-model summary when requested
	groupBy := strings.TrimSpace(r.URL.Query().Get("group_by"))
	includeSummary := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("include_summary")), "true")
	if groupBy == "model" || includeSummary {
		resp["groups"] = computeModelGroups(points)
	}

	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleAnomalies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method == http.MethodPost {
		s.handleAnomalyConfig(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	baseline := parseWindow(r.URL.Query().Get("baseline"), 7*24*time.Hour, "day")
	recent := parseWindow(r.URL.Query().Get("recent"), time.Hour, "hour")
	z := 3.0
	if v := strings.TrimSpace(r.URL.Query().Get("z")); v != "" {
		if parsed, err := strconv.ParseFloat(v, 64); err == nil && parsed > 0 {
			z = parsed
		}
	}
	// parseWindow returns an absolute time; convert back to durations from now.
	now := time.Now()
	findings, err := s.db.ModelAnomalies(r.Context(), now.Sub(baseline), now.Sub(recent), z)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "anomalies_failed")
		return
	}
	costFindings, err := s.db.CostAnomalies(r.Context(), now.Sub(baseline), now.Sub(recent), z)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "cost_anomalies_failed")
		return
	}
	detected := anomalyEventsFromFindings(findings, costFindings, z, now.UTC())
	record := !strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("record")), "0")
	inserted := []store.AnomalyEvent{}
	if record {
		cfg := s.anomalyAlertConfig(r.Context())
		dedupeWindow := now.Sub(recent)
		if dedupeWindow < 15*time.Minute {
			dedupeWindow = 15 * time.Minute
		}
		for _, event := range detected {
			exists, err := s.db.RecentAnomalyEventExists(r.Context(), event.Scope, event.ScopeValue, event.Metric, now.Add(-dedupeWindow))
			if err != nil || exists {
				continue
			}
			event.ID = newID("anom")
			if cfg.Enabled {
				event.Channel, event.Status = s.notifyAnomalyEvent(r.Context(), cfg, event)
			}
			if err := s.db.InsertAnomalyEvent(r.Context(), event); err == nil {
				inserted = append(inserted, event)
			}
		}
	}
	events, _ := s.db.ListAnomalyEvents(r.Context(), recentLimit(r))
	writeJSON(w, http.StatusOK, map[string]any{
		"anomalies":       findings,
		"cost_anomalies":  costFindings,
		"detected_events": detected,
		"inserted_events": inserted,
		"events":          events,
		"alerts":          s.anomalyAlertConfig(r.Context()),
		"z_threshold":     z,
	})
}

type anomalyAlertConfig struct {
	Enabled         bool   `json:"enabled"`
	WebhookURL      string `json:"webhook_url"`
	SlackWebhookURL string `json:"slack_webhook_url"`
}

func (s *Server) handleAnomalyConfig(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Enabled         *bool   `json:"enabled"`
		WebhookURL      *string `json:"webhook_url"`
		SlackWebhookURL *string `json:"slack_webhook_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if payload.Enabled != nil {
		if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "anomaly_alert_enabled", Value: boolStr(*payload.Enabled), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "anomaly_config_failed")
			return
		}
	}
	if payload.WebhookURL != nil {
		if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "anomaly_webhook_url", Value: strings.TrimSpace(*payload.WebhookURL), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "anomaly_config_failed")
			return
		}
	}
	if payload.SlackWebhookURL != nil {
		if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "anomaly_slack_webhook_url", Value: strings.TrimSpace(*payload.SlackWebhookURL), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "anomaly_config_failed")
			return
		}
	}
	s.auditAdmin(r, "anomaly.config", "", auditJSON(s.anomalyAlertConfig(r.Context())))
	writeJSON(w, http.StatusOK, map[string]any{"alerts": s.anomalyAlertConfig(r.Context())})
}

func (s *Server) anomalyAlertConfig(ctx context.Context) anomalyAlertConfig {
	cfg := anomalyAlertConfig{}
	if f, found, err := s.db.GetFlag(ctx, "anomaly_alert_enabled"); err == nil && found {
		cfg.Enabled = strings.EqualFold(strings.TrimSpace(f.Value), "true") || f.Value == "1"
	}
	if f, found, err := s.db.GetFlag(ctx, "anomaly_webhook_url"); err == nil && found {
		cfg.WebhookURL = strings.TrimSpace(f.Value)
	}
	if f, found, err := s.db.GetFlag(ctx, "anomaly_slack_webhook_url"); err == nil && found {
		cfg.SlackWebhookURL = strings.TrimSpace(f.Value)
	}
	return cfg
}

func anomalyEventsFromFindings(modelFindings []store.AnomalyFinding, costFindings []store.CostAnomalyFinding, threshold float64, now time.Time) []store.AnomalyEvent {
	events := []store.AnomalyEvent{}
	for _, finding := range modelFindings {
		if finding.Metric != "cost_per_request" {
			continue
		}
		events = append(events, store.AnomalyEvent{
			Scope:      "model",
			ScopeValue: finding.Model,
			Metric:     finding.Metric,
			Value:      finding.RecentMean,
			Baseline:   finding.BaselineMean,
			Severity:   anomalySeverity(finding.ZScore, threshold),
			Channel:    "admin_ui",
			Status:     "detected",
			CreatedAt:  now,
		})
	}
	for _, finding := range costFindings {
		events = append(events, store.AnomalyEvent{
			Scope:      finding.Scope,
			ScopeValue: finding.ScopeValue,
			Metric:     finding.Metric,
			Value:      finding.RecentValue,
			Baseline:   finding.BaselineMean,
			Severity:   anomalySeverity(finding.ZScore, threshold),
			Channel:    "admin_ui",
			Status:     "detected",
			CreatedAt:  now,
		})
	}
	return events
}

func anomalySeverity(z, threshold float64) string {
	abs := math.Abs(z)
	switch {
	case abs >= threshold*3:
		return "critical"
	case abs >= threshold*2:
		return "high"
	default:
		return "medium"
	}
}

func (s *Server) notifyAnomalyEvent(ctx context.Context, cfg anomalyAlertConfig, event store.AnomalyEvent) (string, string) {
	channels := []string{"admin_ui"}
	status := "detected"
	if cfg.WebhookURL != "" {
		channels = append(channels, "webhook")
		if err := s.postAnomalyWebhook(ctx, cfg.WebhookURL, event, false); err != nil {
			status = "notify_failed"
		} else if status != "notify_failed" {
			status = "notified"
		}
	}
	if cfg.SlackWebhookURL != "" {
		channels = append(channels, "slack")
		if err := s.postAnomalyWebhook(ctx, cfg.SlackWebhookURL, event, true); err != nil {
			status = "notify_failed"
		} else if status != "notify_failed" {
			status = "notified"
		}
	}
	return strings.Join(channels, ","), status
}

func (s *Server) postAnomalyWebhook(ctx context.Context, target string, event store.AnomalyEvent, slack bool) error {
	text := fmt.Sprintf("[Vibe Coders 비용 이상탐지] %s/%s %s: %.2f KRW (baseline %.2f, severity %s)",
		event.Scope, event.ScopeValue, event.Metric, event.Value, event.Baseline, event.Severity)
	payload := map[string]any{
		"text":    text,
		"anomaly": event,
	}
	if slack {
		payload = map[string]any{"text": text}
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *Server) handleHeatmap(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	heat, err := s.db.HeatmapKST(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "heatmap_failed")
		return
	}
	writeJSON(w, http.StatusOK, heat)
}

// handleModelQuality reports a composite per-model coding-quality score over a
// window (default 30d): success rate + golden regression pass + evaluation pass
// rates (overall and per category: compile/tests/security/review).
// GET /admin/models/quality?window=30d
func (s *Server) handleModelQuality(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	scores, err := s.db.ModelQualityScores(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "model_quality_failed")
		return
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].QualityScore > scores[j].QualityScore })
	writeJSON(w, http.StatusOK, map[string]any{
		"since":      since.UTC().Format(time.RFC3339),
		"models":     scores,
		"categories": []string{"compile", "tests", "security", "review"},
	})
}

func parseWindow(raw string, fallback time.Duration, bucket string) time.Time {
	raw = strings.TrimSpace(strings.ToLower(raw))
	dur := fallback
	switch raw {
	case "1h":
		dur = time.Hour
	case "6h":
		dur = 6 * time.Hour
	case "24h", "1d":
		dur = 24 * time.Hour
	case "7d":
		dur = 7 * 24 * time.Hour
	case "30d":
		dur = 30 * 24 * time.Hour
	case "":
		dur = fallback
	default:
		if d, err := time.ParseDuration(raw); err == nil {
			dur = d
		}
	}
	_ = bucket
	return time.Now().Add(-dur)
}
