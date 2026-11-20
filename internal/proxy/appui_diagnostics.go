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

var appUIDiagnosticOperations = sync.OnceValue(func() map[string]bool {
	allowed := map[string]bool{}
	for _, endpoint := range apiEndpoints {
		if strings.HasPrefix(endpoint.path, "/admin/ui-telemetry/") || strings.HasPrefix(endpoint.path, "/admin/ui-diagnostics/") || strings.HasPrefix(endpoint.path, "/auth/") {
			continue
		}
		for _, method := range endpoint.methods {
			allowed[strings.ToUpper(method)+" "+endpoint.path] = true
		}
	}
	return allowed
})

func appUIDiagnosticOperationAllowed(event store.AppUIDiagnostic) bool {
	return event.Kind == "js_error" || appUIDiagnosticOperations()[event.Method+" "+event.Endpoint]
}

func decodeAppUIDiagnostic(decoder *json.Decoder) (string, store.AppUIDiagnostic, bool) {
	var event store.AppUIDiagnostic
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
		case "kind":
			destination = &event.Kind
		case "endpoint":
			destination = &event.Endpoint
		case "method":
			destination = &event.Method
		case "failure":
			destination = &event.Failure
		case "request_id":
			destination = &event.RequestID
		case "boundary":
			destination = &event.Boundary
		case "status":
			var status *int
			if decoder.Decode(&status) != nil || status == nil {
				return nonce, event, false
			}
			event.Status = *status
			continue
		default:
			return nonce, event, false
		}
		var value *string
		if decoder.Decode(&value) != nil || value == nil {
			return nonce, event, false
		}
		*destination = *value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF {
		return nonce, event, false
	}
	for _, key := range []string{"event_id", "feature_id", "kind", "failure"} {
		if !seen[key] {
			return nonce, event, false
		}
	}
	if event.Kind == "api_error" {
		if !seen["endpoint"] || !seen["method"] || !seen["status"] || seen["boundary"] {
			return nonce, event, false
		}
	} else if event.Kind == "js_error" {
		if !seen["boundary"] || len(seen) != 5 {
			return nonce, event, false
		}
	} else {
		return nonce, event, false
	}
	event.RequestID = store.NormalizeAppUIDiagnosticRequestID(event.RequestID)
	return nonce, event, true
}

func (s *Server) handleAppUIDiagnosticEvent(w http.ResponseWriter, r *http.Request) {
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
	nonce, event, decoded := decodeAppUIDiagnostic(json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)))
	bodyConsumed = decoded
	event.UIVersion = store.NormalizeAppUIReleaseVersion(r.Header.Get("X-Vibe-UI-Version"))
	if !decoded || !store.ValidAppUIDiagnosticID(nonce) || !event.Valid() || !appUIDiagnosticOperationAllowed(event) {
		writeOpenAIError(w, 400, "invalid UI diagnostic", "invalid_request_error", "invalid_ui_diagnostic")
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
		writeOpenAIError(w, 403, "feature access denied", "invalid_request_error", "ui_diagnostic_forbidden")
		return
	}
	if _, err := s.db.RecordAppUIDiagnostic(ctx, nonce, event, time.Now().UTC()); err != nil {
		writeOpenAIError(w, 503, "UI diagnostics temporarily unavailable", "server_error", "ui_diagnostic_unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type appUIDiagnosticSummary struct {
	store.AppUIDiagnosticsSummary
	Enabled       bool   `json:"enabled"`
	Days          int    `json:"days"`
	From          string `json:"from"`
	To            string `json:"to"`
	RetentionDays int    `json:"retention_days"`
	EventLimit    int    `json:"event_limit"`
	GroupLimit    int    `json:"group_limit"`
	RecentLimit   int    `json:"recent_limit"`
}

func (s *Server) handleAppUIDiagnosticSummary(w http.ResponseWriter, r *http.Request) {
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
		writeOpenAIError(w, 400, "days must be 7 or 30", "invalid_request_error", "invalid_ui_diagnostic_window")
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
		writeOpenAIError(w, 503, "UI diagnostics temporarily unavailable", "server_error", "ui_diagnostic_unavailable")
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
	result, err := s.db.AppUIDiagnosticsSummary(ctx, from, now, ids)
	if err != nil {
		writeOpenAIError(w, 503, "UI diagnostics temporarily unavailable", "server_error", "ui_diagnostic_unavailable")
		return
	}
	// Recheck even out-of-band DB rows against the static endpoint catalog. An
	// arbitrary path must never become a channel for resource or user identifiers.
	groups := make([]store.AppUIDiagnosticGroup, 0, len(result.Groups))
	for _, group := range result.Groups {
		if appUIDiagnosticOperationAllowed(group.AppUIDiagnostic) {
			groups = append(groups, group)
		} else {
			result.OtherGroupEvents += group.Events
		}
	}
	result.Groups = groups
	recent := make([]store.AppUIDiagnosticRecent, 0, len(result.Recent))
	for _, row := range result.Recent {
		if appUIDiagnosticOperationAllowed(row.AppUIDiagnostic) {
			recent = append(recent, row)
		}
	}
	result.Recent = recent
	writeJSON(w, 200, appUIDiagnosticSummary{AppUIDiagnosticsSummary: result, Enabled: s.appUITelemetryFlag(stored, appUIEnabledKey) && s.appUITelemetryFlag(stored, appUITelemetryEnabledKey), Days: days, From: from.Format(time.RFC3339), To: now.Format(time.RFC3339), RetentionDays: store.AppUITelemetryRetentionDays, EventLimit: store.AppUIDiagnosticLimit, GroupLimit: store.AppUIDiagnosticGroupLimit, RecentLimit: store.AppUIDiagnosticRecentLimit})
}
