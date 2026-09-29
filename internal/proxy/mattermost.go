package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const mattermostSnapshotTTL = 15 * time.Second

// mattermostEventCategories are the notification types operators can toggle.
var mattermostEventCategories = []string{"cost", "secret", "approval", "provider"}

var mattermostFlagKeys = []string{"mattermost_enabled", "mattermost_webhook_url", "mattermost_channel", "mattermost_events"}

// mattermostSnapshot caches the Mattermost notification config so event hooks on
// the hot path can short-circuit cheaply when notifications are disabled.
type mattermostSnapshot struct {
	enabled    bool
	webhookURL string
	channel    string
	events     map[string]bool
	fetchedAt  time.Time
}

func (s *Server) mattermostConfig(ctx context.Context) *mattermostSnapshot {
	if c := s.mmCache.Load(); c != nil && time.Since(c.fetchedAt) < mattermostSnapshotTTL {
		return c
	}
	flags, err := s.db.GetRuntimeFlagSnapshot(ctx, mattermostFlagKeys)
	if err != nil {
		// Notification delivery fails closed; do not cache a partial read.
		return &mattermostSnapshot{events: map[string]bool{}}
	}
	snap := mattermostSnapshotFromFlags(flags)
	s.mmCache.Store(snap)
	return snap
}

func mattermostSnapshotFromFlags(flags map[string]store.RuntimeFlag) *mattermostSnapshot {
	snap := &mattermostSnapshot{events: map[string]bool{}, fetchedAt: time.Now()}
	if f, found := flags["mattermost_enabled"]; found {
		snap.enabled = f.Value == "true" || f.Value == "1"
	}
	if f, found := flags["mattermost_webhook_url"]; found {
		snap.webhookURL = f.Value
	}
	if f, found := flags["mattermost_channel"]; found {
		snap.channel = f.Value
	}
	if f, found := flags["mattermost_events"]; found {
		for _, e := range strings.Split(f.Value, ",") {
			e = strings.TrimSpace(e)
			if containsString(mattermostEventCategories, e) {
				snap.events[e] = true
			}
		}
	} else {
		for _, e := range mattermostEventCategories { // Missing flag only: all categories on.
			snap.events[e] = true
		}
	}
	return snap
}

func mattermostConfigView(cfg *mattermostSnapshot) map[string]any {
	events := []string{}
	for _, event := range mattermostEventCategories {
		if cfg.events[event] {
			events = append(events, event)
		}
	}
	maskedURL, urlSet := settingMaskedValue(cfg.webhookURL, true)
	return map[string]any{"enabled": cfg.enabled, "webhook_url": maskedURL, "webhook_url_set": urlSet,
		"channel": cfg.channel, "events": events, "available_events": mattermostEventCategories}
}

func mattermostWebhookURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || parsed.Opaque != "" {
		return nil, errors.New("webhook must be an absolute HTTP(S) URL")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("webhook must be an absolute HTTP(S) URL")
	}
	return parsed, nil
}

func (s *Server) invalidateMattermostCache() { s.mmCache.Store(nil) }

// notifyMattermost posts a Slack-compatible message to the configured Mattermost
// incoming webhook for the given event category. Best-effort and asynchronous;
// returns immediately (and does nothing) when notifications are disabled, the
// category is muted, or no webhook is configured.
func (s *Server) notifyMattermost(ctx context.Context, category, text string) {
	cfg := s.mattermostConfig(ctx)
	if !cfg.enabled || cfg.webhookURL == "" || !cfg.events[category] {
		return
	}
	payload := map[string]any{"text": "[AI 코딩 프록시] " + text}
	if cfg.channel != "" {
		payload["channel"] = cfg.channel
	}
	body, _ := json.Marshal(payload)
	go func(url string, body []byte) {
		reqCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		target, err := mattermostWebhookURL(url)
		if err != nil {
			return
		}
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, target.String(), bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := s.client.Do(req)
		if err != nil {
			// net/http errors embed the complete webhook URL, including its token.
			slog.Warn("mattermost notify failed")
			return
		}
		_ = resp.Body.Close()
	}(cfg.webhookURL, body)
}

// handleMattermostConfig reads/sets the Mattermost notification config.
// GET /admin/notifications/mattermost · POST {enabled, webhook_url, channel, events[]}
func (s *Server) handleMattermostConfig(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		flags, err := s.db.GetRuntimeFlagSnapshot(r.Context(), mattermostFlagKeys)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "notification configuration could not be loaded", "server_error", "mattermost_config_unavailable")
			return
		}
		writeJSON(w, http.StatusOK, mattermostConfigView(mattermostSnapshotFromFlags(flags)))
	case http.MethodPost:
		var p struct {
			Enabled    *bool    `json:"enabled"`
			WebhookURL *string  `json:"webhook_url"`
			Channel    *string  `json:"channel"`
			Events     []string `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		updates := []store.RuntimeFlag{}
		set := func(key, val string) {
			updates = append(updates, store.RuntimeFlag{Key: key, Value: val, UpdatedBy: adminID(r)})
		}
		if p.Enabled != nil {
			set("mattermost_enabled", boolStr(*p.Enabled))
		}
		if p.WebhookURL != nil {
			value := strings.TrimSpace(*p.WebhookURL)
			if value != "" {
				if _, err := mattermostWebhookURL(value); err != nil {
					writeOpenAIError(w, http.StatusBadRequest, "webhook must be an absolute HTTP(S) URL", "invalid_request_error", "invalid_webhook_url")
					return
				}
			}
			set("mattermost_webhook_url", value)
		}
		if p.Channel != nil {
			set("mattermost_channel", strings.TrimSpace(*p.Channel))
		}
		if p.Events != nil {
			valid := []string{}
			for _, e := range p.Events {
				e = strings.TrimSpace(e)
				if containsString(mattermostEventCategories, e) {
					valid = append(valid, e)
				}
			}
			set("mattermost_events", strings.Join(valid, ","))
		}
		flags, err := s.db.SaveRuntimeFlagBatch(r.Context(), updates, mattermostFlagKeys)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "notification configuration could not be saved", "server_error", "mattermost_config_save_failed")
			return
		}
		s.invalidateMattermostCache()
		view := mattermostConfigView(mattermostSnapshotFromFlags(flags))
		s.auditCommittedSetting(r, "mattermost.config", "", auditJSON(map[string]any{"enabled": view["enabled"], "webhook_url_set": view["webhook_url_set"], "webhook_changed": p.WebhookURL != nil, "events": view["events"]}))
		writeJSON(w, http.StatusOK, view)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleMattermostTest sends a test message to verify the webhook.
// POST /admin/notifications/mattermost/test
func (s *Server) handleMattermostTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	flags, err := s.db.GetRuntimeFlagSnapshot(r.Context(), mattermostFlagKeys)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "notification configuration could not be loaded", "server_error", "mattermost_config_unavailable")
		return
	}
	cfg := mattermostSnapshotFromFlags(flags)
	if cfg.webhookURL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no webhook configured", "invalid_request_error", "no_webhook")
		return
	}
	// Bypass the category gate for the test by posting directly.
	body, _ := json.Marshal(map[string]any{"text": "[AI 코딩 프록시] Mattermost 연동 테스트 메시지입니다. ✅"})
	target, err := mattermostWebhookURL(cfg.webhookURL)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "configured webhook URL is invalid", "invalid_request_error", "invalid_webhook_url")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "configured webhook URL is invalid", "invalid_request_error", "invalid_webhook_url")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "webhook delivery failed", "server_error", "webhook_failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		writeOpenAIError(w, http.StatusBadGateway, "webhook delivery failed", "server_error", "webhook_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "webhook_status": resp.StatusCode})
}
