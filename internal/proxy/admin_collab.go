package proxy

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleRequestNote(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	// Path: /admin/requests/{id}/note
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[1] != "note" {
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	id := parts[0]
	switch r.Method {
	case http.MethodGet:
		note, _, err := s.db.GetRequestNote(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "note_failed")
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut, http.MethodPost:
		// verify the request exists so we don't accumulate orphans
		if _, err := s.db.RequestDetail(r.Context(), id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
				return
			}
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_lookup_failed")
			return
		}
		var payload struct {
			Tags []string `json:"tags"`
			Note string   `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		note := store.RequestNote{
			RequestID: id,
			Tags:      cleanTags(payload.Tags),
			Note:      strings.TrimSpace(payload.Note),
			CreatedBy: adminID(r),
		}
		if err := s.db.UpsertRequestNote(r.Context(), note); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "note_save_failed")
			return
		}
		s.auditAdmin(r, "request_note.upsert", "", auditJSON(map[string]any{"id": id, "tags": note.Tags}))
		writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.db.DeleteRequestNote(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "note_delete_failed")
			return
		}
		s.auditAdmin(r, "request_note.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func cleanTags(input []string) []string {
	out := make([]string, 0, len(input))
	seen := map[string]bool{}
	for _, t := range input {
		t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
		t = strings.ReplaceAll(t, ",", " ")
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// ---------- saved filters ----------

var validSavedViews = map[string]bool{"requests": true, "prompts": true}

func (s *Server) handleSavedFilters(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		filters, err := s.db.ListSavedFilters(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filters_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"filters": filters})
	case http.MethodPost:
		var payload struct {
			Name   string `json:"name"`
			View   string `json:"view"`
			Params string `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.View = strings.TrimSpace(payload.View)
		payload.Params = strings.TrimSpace(payload.Params)
		if payload.Name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		if !validSavedViews[payload.View] {
			writeOpenAIError(w, http.StatusBadRequest, "view must be requests or prompts", "invalid_request_error", "invalid_view")
			return
		}
		if _, err := url.ParseQuery(payload.Params); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "params must be a URL-encoded query string", "invalid_request_error", "invalid_params")
			return
		}
		f := store.SavedFilter{
			ID:        newID("filt"),
			Name:      payload.Name,
			View:      payload.View,
			Params:    payload.Params,
			CreatedBy: adminID(r),
		}
		if err := s.db.UpsertSavedFilter(r.Context(), f); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filter_save_failed")
			return
		}
		s.auditAdmin(r, "saved_filter.create", "", auditJSON(f))
		writeJSON(w, http.StatusCreated, map[string]any{"filter": f})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleSavedFilterByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/saved-filters/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid filter id", "invalid_request_error", "invalid_filter_id")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if err := s.db.DeleteSavedFilter(r.Context(), id); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filter_delete_failed")
		return
	}
	s.auditAdmin(r, "saved_filter.delete", auditJSON(map[string]string{"id": id}), "")
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
}

// ---------- audit CSV ----------

func (s *Server) handleAuditExportCSV(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	limit := exportLimit(r)
	audits, err := s.db.ListAdminAudit(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "audit_export_failed")
		return
	}
	events, err := s.db.ListAlertEvents(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "audit_export_failed")
		return
	}

	stamp := time.Now().UTC().Format("20060102-150405")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=audit-%s.csv", stamp))
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM for Excel

	wr := csv.NewWriter(w)
	_ = wr.Write([]string{"created_at", "kind", "actor", "action", "detail_before", "detail_after"})
	for _, a := range audits {
		_ = wr.Write([]string{a.CreatedAt, "admin_audit", a.AdminID, a.Action, a.BeforeValue, a.AfterValue})
	}
	for _, e := range events {
		detail := fmt.Sprintf("rule=%s metric=%s value=%.2f threshold=%.2f delivered=%t err=%s",
			e.RuleName, e.Metric, e.Value, e.Threshold, e.Delivered, e.DeliveryError)
		_ = wr.Write([]string{e.CreatedAt.UTC().Format(time.RFC3339), "alert_event", e.RuleID, "alert.fire", "", detail})
	}
	wr.Flush()
}
