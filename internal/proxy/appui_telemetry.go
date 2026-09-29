package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

const appUITelemetryBodyLimit = 1024

// This gate retains no client, user, team, address, token, or visit identifiers.
// It bounds aggregate process intake, including authentication/settings DB work.
type appUITelemetryLimiter struct {
	mu       sync.Mutex
	tokens   float64
	last     time.Time
	inFlight int
}

var processAppUITelemetryLimiter appUITelemetryLimiter

func (g *appUITelemetryLimiter) acquire(now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.last.IsZero() {
		g.tokens = 40
	} else if elapsed := now.Sub(g.last).Seconds(); elapsed > 0 {
		g.tokens = min(40, g.tokens+elapsed*20)
	}
	g.last = now
	if g.inFlight >= 4 || g.tokens < 1 {
		return false
	}
	g.tokens--
	g.inFlight++
	return true
}

func (g *appUITelemetryLimiter) release() {
	g.mu.Lock()
	g.inFlight--
	g.mu.Unlock()
}

type appUITelemetryEvent struct {
	FeatureID string `json:"feature_id"`
	VisitID   string `json:"visit_id"`
	Event     string `json:"event"`
}

type appUITelemetrySummary struct {
	Enabled       bool                        `json:"enabled"`
	Days          int                         `json:"days"`
	From          string                      `json:"from"`
	To            string                      `json:"to"`
	RetentionDays int                         `json:"retention_days"`
	VisitLimit    int                         `json:"visit_limit"`
	Features      []store.AppUITelemetryCount `json:"features"`
}

// Read effective opt-in at admission, not from the eventually convergent runtime
// snapshot. Requests admitted before opt-out may complete; pending work gets a
// two-second cancellation budget, not a hard DB-cleanup/response-time guarantee.
// Subsequent requests observe the shared DB opt-out without waiting for pod reload.
func (s *Server) appUITelemetryFlag(stored map[string]store.AdminSetting, key string) bool {
	def, ok := settingDefByKey(key)
	if !ok {
		return false
	}
	value, _, err := s.effectiveSettingValue(stored, def)
	if err != nil {
		return false
	}
	enabled, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && enabled
}

func (s *Server) handleAppUITelemetryEvent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	gate := s.appUITelemetryGate
	if gate == nil {
		gate = &processAppUITelemetryLimiter
	}
	if !gate.acquire(time.Now()) {
		// Lossy observational metrics never ask the browser to queue or retry.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	defer gate.release()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	stored, err := s.loadStoredSettings(r)
	if err != nil || !s.appUITelemetryFlag(stored, appUIEnabledKey) || !s.appUITelemetryFlag(stored, appUITelemetryEnabledKey) {
		// Fail closed before parsing or authenticating an opted-out request. No
		// telemetry writes, authentication audits, or payload logging occur.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil {
		writeOpenAIError(w, http.StatusUnauthorized, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	// Context cancellation alone does not interrupt net/http request-body reads.
	// Bound slow bodies as well as DB/auth work, so four slow clients cannot hold
	// the entire intake gate. Standard server ResponseWriters support this; test
	// recorders may return ErrNotSupported. Restore the deadline only after EOF:
	// clearing it for a partial body lets net/http's post-handler drain block again.
	controller := http.NewResponseController(w)
	bodyConsumed := false
	if deadline, ok := ctx.Deadline(); ok {
		_ = controller.SetReadDeadline(deadline)
		defer func() {
			if bodyConsumed {
				_ = controller.SetReadDeadline(time.Time{})
			}
		}()
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, appUITelemetryBodyLimit))
	event, decoded := decodeAppUITelemetryEvent(decoder)
	bodyConsumed = decoded
	if !decoded || !validAppUITelemetryEvent(event) {
		writeOpenAIError(w, http.StatusBadRequest, "invalid UI telemetry event", "invalid_request_error", "invalid_ui_telemetry_event")
		return
	}
	legacyFallback := s.appUITelemetryFlag(stored, appUILegacyFallbackKey)
	features := effectiveAppUIFeaturesWithFallback(stored, s, user.ID, user.Role, user.Scopes, true, legacyFallback)
	allowed := false
	for _, feature := range features {
		if feature.FeatureID != event.FeatureID || !feature.Available {
			continue
		}
		allowed = event.Event == "visit" || (legacyFallback && feature.FallbackEnabled && feature.LegacyPath != "" && feature.Status != "retired")
		break
	}
	if !allowed {
		writeOpenAIError(w, http.StatusForbidden, "feature access denied", "invalid_request_error", "ui_telemetry_forbidden")
		return
	}
	// Identity is used for existing RBAC/rollout checks only. The store receives
	// no identity or browser metadata; it hashes the ephemeral random visit ID.
	if _, err := s.db.RecordAppUITelemetry(ctx, event.FeatureID, event.VisitID, event.Event == "legacy_fallback", time.Now().UTC()); err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "UI telemetry temporarily unavailable", "server_error", "ui_telemetry_unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Decode explicit, case-sensitive keys and reject duplicates as well as unknown
// fields. A permissive struct decoder accepts case variants and last-key wins.
func decodeAppUITelemetryEvent(decoder *json.Decoder) (appUITelemetryEvent, bool) {
	var event appUITelemetryEvent
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return event, false
	}
	seen := make(map[string]bool, 3)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return event, false
		}
		seen[key] = true
		var destination *string
		switch key {
		case "feature_id":
			destination = &event.FeatureID
		case "visit_id":
			destination = &event.VisitID
		case "event":
			destination = &event.Event
		default:
			return event, false
		}
		if err := decoder.Decode(destination); err != nil {
			return event, false
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(seen) != 3 {
		return event, false
	}
	return event, decoder.Decode(new(any)) == io.EOF
}

func validAppUITelemetryEvent(event appUITelemetryEvent) bool {
	if event.Event != "visit" && event.Event != "legacy_fallback" {
		return false
	}
	if len(event.VisitID) != 32 {
		return false
	}
	for _, c := range event.VisitID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	for _, feature := range appUIFeatures {
		if feature.FeatureID == event.FeatureID {
			return true
		}
	}
	return false
}

func (s *Server) handleAppUITelemetrySummary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "admin read permission required", "invalid_request_error", "invalid_access_token")
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil {
		writeOpenAIError(w, http.StatusUnauthorized, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	days := 7
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil || len(query) > 1 || (len(query) == 1 && len(query["days"]) != 1) {
		writeOpenAIError(w, http.StatusBadRequest, "days must be 7 or 30", "invalid_request_error", "invalid_ui_telemetry_window")
		return
	}
	if value, exists := query["days"]; exists {
		if value[0] != "7" && value[0] != "30" {
			writeOpenAIError(w, http.StatusBadRequest, "days must be 7 or 30", "invalid_request_error", "invalid_ui_telemetry_window")
			return
		}
		days, _ = strconv.Atoi(value[0])
	}
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "UI telemetry temporarily unavailable", "server_error", "ui_telemetry_unavailable")
		return
	}
	now := time.Now().UTC()
	from := now.Add(-time.Duration(days) * 24 * time.Hour)
	counts, err := s.db.AppUITelemetrySummary(r.Context(), from, now)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "UI telemetry temporarily unavailable", "server_error", "ui_telemetry_unavailable")
		return
	}
	byFeature := make(map[string]store.AppUITelemetryCount, len(counts))
	for _, count := range counts {
		byFeature[count.FeatureID] = count
	}
	visible := make([]store.AppUITelemetryCount, 0, len(appUIFeatures))
	for _, feature := range effectiveAppUIFeaturesWithFallback(stored, s, user.ID, user.Role, user.Scopes, true, s.appUITelemetryFlag(stored, appUILegacyFallbackKey)) {
		if feature.Available {
			count := byFeature[feature.FeatureID]
			count.FeatureID = feature.FeatureID
			visible = append(visible, count)
		}
	}
	writeJSON(w, http.StatusOK, appUITelemetrySummary{
		Enabled: s.appUITelemetryFlag(stored, appUIEnabledKey) && s.appUITelemetryFlag(stored, appUITelemetryEnabledKey),
		Days:    days, From: from.Format(time.RFC3339), To: now.Format(time.RFC3339),
		RetentionDays: store.AppUITelemetryRetentionDays, VisitLimit: store.AppUITelemetryVisitLimit, Features: visible,
	})
}

// Privacy retention runs even when UI telemetry and the normal retention worker
// are disabled. A closed store cancels this loop; failures retry on the next tick
// without emitting database errors or captured payloads to a logger.
func (s *Server) appUITelemetryRetentionLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		purgeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_ = s.db.PurgeAppUITelemetry(purgeCtx, time.Now().UTC())
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
