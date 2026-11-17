package proxy

import (
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type promptProductMetadataItem struct {
	Name           string  `json:"name"`
	Category       string  `json:"category"`
	TemplateState  string  `json:"template_state"`
	SourceRequests *int64  `json:"source_requests"`
	SourceKeys     *int64  `json:"source_distinct_keys"`
	UseCount       *int64  `json:"use_count"`
	LastUsedAt     *string `json:"last_used_at"`
	CreatedAt      *string `json:"created_at"`
}

func promptProductMetadataCount(value int64) *int64 {
	if value < 0 || value > 9007199254740991 {
		return nil
	}
	return &value
}

func promptProductMetadataOptionalCount(value *int64) *int64 {
	if value == nil {
		return nil
	}
	return promptProductMetadataCount(*value)
}

// The existing handler has already applied global admin:read authorization.
func (s *Server) writePromptProductMetadata(w http.ResponseWriter, r *http.Request, query url.Values) {
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
	if !valid || limit < 1 || limit > 100 || offset < 0 || offset > 1000000 || (state != "all" && state != "enabled" && state != "disabled" && state != "missing") {
		writeOpenAIError(w, 400, "invalid prompt product metadata page", "invalid_request_error", "invalid_product_page")
		return
	}
	rows, total, err := s.db.PromptProductMetadataPage(r.Context(), state, limit, offset)
	if err != nil {
		writeOpenAIError(w, 500, "prompt product metadata could not be loaded", "server_error", "product_metadata_failed")
		return
	}
	items := make([]promptProductMetadataItem, 0, len(rows))
	for _, row := range rows {
		name, category := row.Name, row.Category
		if !s.safeResourceSearchText(name) {
			name = "[숨김]"
		}
		if !s.safeResourceSearchText(category) {
			category = "[숨김]"
		}
		var uses *int64
		if row.UseCount != nil {
			uses = promptProductMetadataCount(*row.UseCount)
		}
		items = append(items, promptProductMetadataItem{name, category, row.TemplateState, promptProductMetadataOptionalCount(row.SourceRequests), promptProductMetadataOptionalCount(row.DistinctKeys), uses, contextMetadataTime(row.LastUsedAt), contextMetadataTime(row.CreatedAt)})
	}
	writeJSON(w, 200, struct {
		Items       []promptProductMetadataItem `json:"items"`
		Total       int                         `json:"total"`
		Limit       int                         `json:"limit"`
		Offset      int                         `json:"offset"`
		State       string                      `json:"state"`
		GeneratedAt time.Time                   `json:"generated_at"`
	}{items, total, limit, offset, state, time.Now().UTC()})
}
