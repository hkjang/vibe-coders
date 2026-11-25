package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"vibe-coders/internal/store"
)

func decodeAppUIAction(decoder *json.Decoder) (string, store.AppUIAction, bool) {
	var event store.AppUIAction
	var nonce string
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nonce, event, false
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return nonce, event, false
		}
		seen[key] = true
		var destination *string
		switch key {
		case "event_id":
			destination = &nonce
		case "feature_id":
			destination = &event.FeatureID
		case "action":
			destination = &event.Action
		case "outcome":
			destination = &event.Outcome
		default:
			return nonce, event, false
		}
		var value *string
		if decoder.Decode(&value) != nil || value == nil {
			return nonce, event, false
		}
		*destination = *value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(seen) != 4 {
		return nonce, event, false
	}
	return nonce, event, true
}

func (s *Server) handleAppUIActionEvent(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	controller := http.NewResponseController(w)
	bodyConsumed := false
	deadline, _ := ctx.Deadline()
	_ = controller.SetReadDeadline(deadline)
	defer func() {
		if bodyConsumed {
			_ = controller.SetReadDeadline(time.Time{})
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	gate := s.appUITelemetryGate
	if gate == nil {
		gate = &processAppUITelemetryLimiter
	}
	if !gate.acquire(time.Now()) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	defer gate.release()
	stored, err := s.loadStoredSettings(r)
	if err != nil || !s.appUITelemetryFlag(stored, appUIEnabledKey) || !s.appUITelemetryFlag(stored, appUITelemetryEnabledKey) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil {
		writeOpenAIError(w, 401, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	quota := s.appUITelemetryCallerQuota
	if quota == nil {
		quota = &processAppUITelemetryCallerQuota
	}
	if !quota.acquire(user.ID, time.Now()) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	nonce, event, decoded := decodeAppUIAction(json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)))
	bodyConsumed = decoded
	event.UIVersion = store.NormalizeAppUIReleaseVersion(r.Header.Get("X-Vibe-UI-Version"))
	if !decoded || !store.ValidAppUIDiagnosticID(nonce) || !event.Valid() {
		writeOpenAIError(w, 400, "invalid UI action observation", "invalid_request_error", "invalid_ui_action")
		return
	}
	features := effectiveAppUIFeaturesWithFallback(stored, s, user.ID, user.Role, user.Scopes, true, s.appUITelemetryFlag(stored, appUILegacyFallbackKey))
	allowed := false
	for _, feature := range features {
		if feature.FeatureID == event.FeatureID && feature.Available {
			allowed = true
			break
		}
	}
	if !allowed {
		writeOpenAIError(w, 403, "feature access denied", "invalid_request_error", "ui_action_forbidden")
		return
	}
	if _, err := s.db.RecordAppUIAction(ctx, nonce, event, time.Now().UTC()); err != nil {
		writeOpenAIError(w, 503, "UI observations temporarily unavailable", "server_error", "ui_action_unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type appUIActionSummary struct {
	store.AppUIActionsSummary
	Enabled       bool   `json:"enabled"`
	Days          int    `json:"days"`
	From          string `json:"from"`
	To            string `json:"to"`
	RetentionDays int    `json:"retention_days"`
	EventLimit    int    `json:"event_limit"`
	GroupLimit    int    `json:"group_limit"`
}

func (s *Server) handleAppUIActionSummary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "admin read permission required", "invalid_request_error", "invalid_access_token")
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil {
		writeOpenAIError(w, 401, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	days := 7
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) > 1 || (len(query) == 1 && (len(query["days"]) != 1 || (query["days"][0] != "7" && query["days"][0] != "30"))) {
		writeOpenAIError(w, 400, "days must be 7 or 30", "invalid_request_error", "invalid_ui_action_window")
		return
	}
	if value := query.Get("days"); value != "" {
		days, _ = strconv.Atoi(value)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		writeOpenAIError(w, 503, "UI observations temporarily unavailable", "server_error", "ui_action_unavailable")
		return
	}
	features := effectiveAppUIFeaturesWithFallback(stored, s, user.ID, user.Role, user.Scopes, true, s.appUITelemetryFlag(stored, appUILegacyFallbackKey))
	ids := []string{}
	for _, feature := range features {
		if feature.Available {
			ids = append(ids, feature.FeatureID)
		}
	}
	now := time.Now().UTC()
	from := now.Add(-time.Duration(days) * 24 * time.Hour)
	result, err := s.db.AppUIActionsSummary(ctx, from, now, ids)
	if err != nil {
		writeOpenAIError(w, 503, "UI observations temporarily unavailable", "server_error", "ui_action_unavailable")
		return
	}
	writeJSON(w, 200, appUIActionSummary{AppUIActionsSummary: result, Enabled: s.appUITelemetryFlag(stored, appUIEnabledKey) && s.appUITelemetryFlag(stored, appUITelemetryEnabledKey), Days: days, From: from.Format(time.RFC3339), To: now.Format(time.RFC3339), RetentionDays: store.AppUITelemetryRetentionDays, EventLimit: store.AppUIActionLimit, GroupLimit: store.AppUIActionGroupLimit})
}
