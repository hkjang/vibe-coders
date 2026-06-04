package proxy

import (
	"net/http"
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
