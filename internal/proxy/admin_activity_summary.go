package proxy

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type activityPeriod struct {
	Window      string    `json:"window"`
	Since       time.Time `json:"since"`
	GeneratedAt time.Time `json:"generated_at"`
}

func (s *Server) activitySummaryPeriod(w http.ResponseWriter, r *http.Request) (activityPeriod, bool) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return activityPeriod{}, false
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return activityPeriod{}, false
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	window := query.Get("window")
	if len(query) == 0 {
		window = "24h"
	}
	duration, valid := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[window]
	if err != nil || !valid || len(query) > 1 || (len(query) == 1 && len(query["window"]) != 1) {
		writeOpenAIError(w, 400, "invalid summary period", "invalid_request_error", "invalid_window")
		return activityPeriod{}, false
	}
	now := time.Now().UTC()
	return activityPeriod{Window: window, Since: now.Add(-duration), GeneratedAt: now}, true
}

func activitySummaryFailure(w http.ResponseWriter) {
	writeOpenAIError(w, 500, "activity summary could not be loaded", "server_error", "activity_summary_failed")
}

func (s *Server) handleAlertSummary(w http.ResponseWriter, r *http.Request) {
	period, ok := s.activitySummaryPeriod(w, r)
	if !ok {
		return
	}
	events, err := s.db.RecentAlertEventMetadata(r.Context(), period.Since, period.GeneratedAt)
	if err != nil {
		activitySummaryFailure(w)
		return
	}
	hasMore := len(events) > 5
	if hasMore {
		events = events[:5]
	}
	for i := range events {
		if !validAlertMetrics[events[i].Metric] {
			events[i].Metric = "other"
		}
	}
	writeJSON(w, 200, struct {
		activityPeriod
		Events  []store.AlertEventMetadata `json:"events"`
		HasMore bool                       `json:"has_more"`
	}{period, events, hasMore})
}

type auditActivity struct {
	Category  string `json:"category"`
	Operation string `json:"operation"`
	CreatedAt string `json:"created_at"`
}

// Only a finite vocabulary reaches the browser. Historic/custom action strings
// can contain resource identifiers and must not be treated as safe labels.
func auditActivityKinds(action string) (string, string) {
	parts := strings.Split(action, ".")
	category, operation := "other", "other"
	switch parts[0] {
	case "provider", "providers":
		category = "provider"
	case "model", "models", "pricing":
		category = "model"
	case "routing", "route":
		category = "routing"
	case "policy", "policies", "safety", "approval":
		category = "policy"
	case "alert", "alerts":
		category = "alert"
	case "auth", "user", "users", "team", "teams", "api_key", "apikey":
		category = "access"
	case "mcp":
		category = "mcp"
	case "text2sql":
		category = "text2sql"
	case "settings", "setting", "config":
		category = "settings"
	case "budget", "quota", "cost":
		category = "cost"
	}
	if len(parts) > 1 {
		switch parts[len(parts)-1] {
		case "create", "add":
			operation = "create"
		case "update", "patch", "save", "set":
			operation = "update"
		case "delete", "remove":
			operation = "delete"
		case "enable", "disable", "revoke", "rotate", "approve", "reject", "import", "rollback", "test":
			operation = parts[len(parts)-1]
		}
	}
	return category, operation
}

func (s *Server) handleAuditSummary(w http.ResponseWriter, r *http.Request) {
	period, ok := s.activitySummaryPeriod(w, r)
	if !ok {
		return
	}
	entries, err := s.db.RecentAdminAuditMetadata(r.Context(), period.Since, period.GeneratedAt)
	if err != nil {
		activitySummaryFailure(w)
		return
	}
	hasMore := len(entries) > 5
	if hasMore {
		entries = entries[:5]
	}
	changes := make([]auditActivity, 0, len(entries))
	for _, entry := range entries {
		category, operation := auditActivityKinds(entry.Action)
		changes = append(changes, auditActivity{category, operation, entry.CreatedAt})
	}
	writeJSON(w, 200, struct {
		activityPeriod
		Changes []auditActivity `json:"changes"`
		HasMore bool            `json:"has_more"`
	}{period, changes, hasMore})
}

type incidentActivity struct {
	Provider    string `json:"provider"`
	StartedAt   string `json:"started_at"`
	EndedAt     string `json:"ended_at"`
	Failovers   int64  `json:"failovers"`
	Errors5xx   int64  `json:"errors_5xx"`
	Requests    int64  `json:"requests"`
	CurrentHour bool   `json:"current_hour"`
}

func (s *Server) handleIncidentSummary(w http.ResponseWriter, r *http.Request) {
	period, ok := s.activitySummaryPeriod(w, r)
	if !ok {
		return
	}
	incidents, err := s.db.IncidentSignals(r.Context(), period.Since, period.GeneratedAt)
	if err != nil {
		activitySummaryFailure(w)
		return
	}
	current := 0
	for _, incident := range incidents {
		if incident.Ongoing {
			current++
		}
	}
	sort.SliceStable(incidents, func(i, j int) bool {
		if incidents[i].Ongoing != incidents[j].Ongoing {
			return incidents[i].Ongoing
		}
		if incidents[i].StartedAt != incidents[j].StartedAt {
			return incidents[i].StartedAt > incidents[j].StartedAt
		}
		return incidents[i].Provider < incidents[j].Provider
	})
	total := len(incidents)
	if total > 5 {
		incidents = incidents[:5]
	}
	signals := make([]incidentActivity, 0, len(incidents))
	for _, incident := range incidents {
		signals = append(signals, incidentActivity{
			Provider:  s.boundedModelsProviderLabelForConfig(incident.Provider),
			StartedAt: incident.StartedAt, EndedAt: incident.EndedAt,
			Failovers: incident.Failovers, Errors5xx: incident.Errors5xx,
			Requests: incident.Requests, CurrentHour: incident.Ongoing,
		})
	}
	writeJSON(w, 200, struct {
		activityPeriod
		Signals     []incidentActivity `json:"signals"`
		Total       int                `json:"total"`
		CurrentHour int                `json:"current_hour"`
		MinEvents   int                `json:"min_events"`
	}{period, signals, total, current, 5})
}
