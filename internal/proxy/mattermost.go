package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const mattermostSnapshotTTL = 15 * time.Second

// mattermostEventCategories are the notification types operators can toggle.
var mattermostEventCategories = []string{"cost", "secret", "approval", "provider"}

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
	snap := &mattermostSnapshot{events: map[string]bool{}, fetchedAt: time.Now()}
	if f, found, err := s.db.GetFlag(ctx, "mattermost_enabled"); err == nil && found {
		snap.enabled = f.Value == "true" || f.Value == "1"
	}
	if f, found, err := s.db.GetFlag(ctx, "mattermost_webhook_url"); err == nil && found {
		snap.webhookURL = f.Value
	}
	if f, found, err := s.db.GetFlag(ctx, "mattermost_channel"); err == nil && found {
		snap.channel = f.Value
	}
	if f, found, err := s.db.GetFlag(ctx, "mattermost_events"); err == nil && found && strings.TrimSpace(f.Value) != "" {
		for _, e := range strings.Split(f.Value, ",") {
			snap.events[strings.TrimSpace(e)] = true
		}
	} else {
		for _, e := range mattermostEventCategories { // default: all categories on
			snap.events[e] = true
		}
	}
	s.mmCache.Store(snap)
	return snap
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
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := s.client.Do(req)
		if err != nil {
			slog.Warn("mattermost notify failed", "error", err)
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
		cfg := s.mattermostConfig(r.Context())
		events := []string{}
		for _, e := range mattermostEventCategories {
			if cfg.events[e] {
				events = append(events, e)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": cfg.enabled, "webhook_url": cfg.webhookURL, "channel": cfg.channel,
			"events": events, "available_events": mattermostEventCategories,
		})
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
		set := func(key, val string) {
			_ = s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: key, Value: val, UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)})
		}
		if p.Enabled != nil {
			set("mattermost_enabled", boolStr(*p.Enabled))
		}
		if p.WebhookURL != nil {
			set("mattermost_webhook_url", strings.TrimSpace(*p.WebhookURL))
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
		s.invalidateMattermostCache()
		s.auditAdmin(r, "mattermost.config", "", auditJSON(p))
		cfg := s.mattermostConfig(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"enabled": cfg.enabled, "webhook_url": cfg.webhookURL, "channel": cfg.channel})
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
	cfg := s.mattermostConfig(r.Context())
	if cfg.webhookURL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no webhook configured", "invalid_request_error", "no_webhook")
		return
	}
	// Bypass the category gate for the test by posting directly.
	body, _ := json.Marshal(map[string]any{"text": "[AI 코딩 프록시] Mattermost 연동 테스트 메시지입니다. ✅"})
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.webhookURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "webhook post failed: "+err.Error(), "server_error", "webhook_failed")
		return
	}
	defer resp.Body.Close()
	writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "webhook_status": resp.StatusCode})
}
