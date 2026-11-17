package proxy

import (
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type contextMetadataItem struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Enabled       bool    `json:"enabled"`
	TokenEstimate *int    `json:"token_estimate"`
	UseCount      *int    `json:"use_count"`
	LastUsedAt    *string `json:"last_used_at"`
	UpdatedAt     *string `json:"updated_at"`
}

func contextMetadataCount(value int) *int {
	if value < 0 {
		return nil
	}
	return &value
}

func contextMetadataTime(value string) *string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.IsZero() {
		return nil
	}
	stamp := parsed.UTC().Format(time.RFC3339Nano)
	return &stamp
}

// Called only after handleContexts has applied the existing admin authorization.
func (s *Server) writeContextMetadata(w http.ResponseWriter, r *http.Request, query url.Values) {
	w.Header().Set("Cache-Control", "no-store")
	limit, offset, state := 25, 0, "all"
	valid := query.Get("view") == "metadata"
	for key, values := range query {
		if len(values) != 1 {
			valid = false
		}
		switch key {
		case "view":
		case "limit", "offset":
			value, err := strconv.Atoi(query.Get(key))
			if err != nil || strconv.Itoa(value) != query.Get(key) {
				valid = false
			}
			if key == "limit" {
				limit = value
			} else {
				offset = value
			}
		case "state":
			state = query.Get(key)
		default:
			valid = false
		}
	}
	if !valid || limit < 1 || limit > 100 || offset < 0 || offset > 1000000 || (state != "all" && state != "enabled" && state != "disabled") {
		writeOpenAIError(w, 400, "invalid context metadata page", "invalid_request_error", "invalid_context_page")
		return
	}
	var enabled *bool
	if state != "all" {
		value := state == "enabled"
		enabled = &value
	}
	rows, total, err := s.db.ContextMetadataPage(r.Context(), enabled, limit, offset)
	if err != nil {
		writeOpenAIError(w, 500, "context metadata could not be loaded", "server_error", "context_metadata_failed")
		return
	}
	items := make([]contextMetadataItem, 0, len(rows))
	for _, row := range rows {
		key, name := row.Key, row.Name
		if !s.safeResourceSearchText(key) {
			key = "[숨김]"
		}
		if !s.safeResourceSearchText(name) {
			name = "[숨김]"
		}
		items = append(items, contextMetadataItem{key, name, row.Enabled, contextMetadataCount(row.TokenEstimate), contextMetadataCount(row.UseCount), contextMetadataTime(row.LastUsedAt), contextMetadataTime(row.UpdatedAt)})
	}
	writeJSON(w, 200, struct {
		Items       []contextMetadataItem `json:"items"`
		Total       int                   `json:"total"`
		Limit       int                   `json:"limit"`
		Offset      int                   `json:"offset"`
		State       string                `json:"state"`
		GeneratedAt time.Time             `json:"generated_at"`
	}{items, total, limit, offset, state, time.Now().UTC()})
}
