package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
)

// The caller has already applied the unchanged administrator read policy.
func (s *Server) handleWorkflowReadView(w http.ResponseWriter, r *http.Request, view string) {
	w.Header().Set("Cache-Control", "no-store")
	invalid := func() {
		writeOpenAIError(w, http.StatusBadRequest, "invalid workflow query", "invalid_request_error", "invalid_workflow_query")
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		invalid()
		return
	}
	for _, key := range []string{"view", "id", "q", "status", "sort", "limit", "offset"} {
		if len(values[key]) > 1 {
			invalid()
			return
		}
	}
	if view == "detail" {
		for _, key := range []string{"q", "status", "sort", "limit", "offset"} {
			if values.Has(key) {
				invalid()
				return
			}
		}
		id := values.Get("id")
		if !store.ValidWorkflowDetailID(id) {
			invalid()
			return
		}
		workflow, found, err := s.db.GetWorkflow(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "failed to load workflow", "server_error", "workflow_detail_failed")
			return
		}
		var result *store.Workflow
		if found {
			result = &workflow
		}
		writeJSON(w, http.StatusOK, map[string]any{"workflow": result})
		return
	}
	if view != "page" || values.Has("id") {
		invalid()
		return
	}
	query := store.WorkflowQuery{Search: values.Get("q"), Limit: 25}
	switch values.Get("status") {
	case "", "all":
	case "enabled", "disabled":
		enabled := values.Get("status") == "enabled"
		query.Enabled = &enabled
	default:
		invalid()
		return
	}
	for _, item := range []struct {
		key    string
		target *int
	}{{"limit", &query.Limit}, {"offset", &query.Offset}} {
		if values.Has(item.key) {
			parsed, err := strconv.Atoi(values.Get(item.key))
			if err != nil {
				invalid()
				return
			}
			*item.target = parsed
		}
	}
	if values.Has("sort") {
		for _, item := range strings.Split(values.Get("sort"), ",") {
			field, direction, found := strings.Cut(item, ":")
			if !found || (direction != "asc" && direction != "desc") {
				invalid()
				return
			}
			query.Sort = append(query.Sort, store.WorkflowSort{Field: field, Desc: direction == "desc"})
		}
	}
	page, err := s.db.ListWorkflowPage(r.Context(), query)
	if errors.Is(err, store.ErrInvalidWorkflowQuery) {
		invalid()
		return
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to load workflows", "server_error", "workflow_page_failed")
		return
	}
	writeJSON(w, http.StatusOK, page)
}
