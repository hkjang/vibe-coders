package proxy

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

func (s *Server) handleRequestNote(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, PUT, DELETE")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id, valid := adminTracePathID(r.URL.Path, "/admin/requests/", "/note")
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		slog.Error("request note scope lookup failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request lookup failed", "server_error", "request_lookup_failed")
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	switch r.Method {
	case http.MethodGet:
		note, _, err := s.db.GetRequestNote(r.Context(), id)
		if err != nil {
			slog.Error("request note query failed", "request_id", id, "error", err)
			writeOpenAIError(w, http.StatusInternalServerError, "request note could not be loaded", "server_error", "note_failed")
			return
		}
		maskRequestNoteForExternal(&note, s.canViewRawPrompts(r), s.externalCredentialProjectionArgs(detail.Request.Provider, detail.Request.FallbackFrom)...)
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut, http.MethodPost:
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
			slog.Error("request note save failed", "request_id", id, "error", err)
			writeOpenAIError(w, http.StatusInternalServerError, "request note could not be saved", "server_error", "note_save_failed")
			return
		}
		// Tags are operator-controlled and may accidentally contain a secret. Keep the
		// audit record useful without persisting their raw values a second time.
		s.auditAdmin(r, "request_note.upsert", "", auditJSON(map[string]any{"id": id, "tag_count": len(note.Tags)}))
		maskRequestNoteForExternal(&note, s.canViewRawPrompts(r), s.externalCredentialProjectionArgs(detail.Request.Provider, detail.Request.FallbackFrom)...)
		writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.db.DeleteRequestNote(r.Context(), id); err != nil {
			slog.Error("request note delete failed", "request_id", id, "error", err)
			writeOpenAIError(w, http.StatusInternalServerError, "request note could not be deleted", "server_error", "note_delete_failed")
			return
		}
		s.auditAdmin(r, "request_note.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	}
}

func maskRequestNoteForExternal(note *store.RequestNote, showRaw bool, rawProviders ...string) {
	if note == nil || showRaw {
		return
	}
	note.Note = audit.Redact(boundedExternalProviderText(note.Note, rawProviders...))
	note.CreatedBy = audit.Redact(boundedExternalProviderText(note.CreatedBy, rawProviders...))
	for index := range note.Tags {
		note.Tags[index] = audit.Redact(boundedExternalProviderText(note.Tags[index], rawProviders...))
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

var validSavedViews = map[string]bool{"requests": true, "prompts": true, "xview": true}

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
		if view := strings.TrimSpace(r.URL.Query().Get("view")); view != "" {
			if !validSavedViews[view] {
				writeOpenAIError(w, http.StatusBadRequest, "invalid saved filter view", "invalid_request_error", "invalid_view")
				return
			}
			filtered := make([]store.SavedFilter, 0)
			for _, filter := range filters {
				if filter.View == view {
					filtered = append(filtered, filter)
				}
			}
			filters = filtered
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
			writeOpenAIError(w, http.StatusBadRequest, "view must be requests, prompts, or xview", "invalid_request_error", "invalid_view")
			return
		}
		if err := validateSavedFilterParams(payload.View, payload.Params); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_params")
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

	existing, found, err := s.db.GetSavedFilter(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filter_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "saved filter not found", "invalid_request_error", "saved_filter_not_found")
		return
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"filter": existing})
	case http.MethodPut, http.MethodPatch:
		var payload struct {
			Name   *string `json:"name"`
			View   string  `json:"view"`
			Params *string `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if payload.View != "" && strings.TrimSpace(payload.View) != existing.View {
			writeOpenAIError(w, http.StatusBadRequest, "saved filter view cannot be changed", "invalid_request_error", "immutable_view")
			return
		}
		updated := existing
		if payload.Name != nil {
			updated.Name = strings.TrimSpace(*payload.Name)
			if updated.Name == "" {
				writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
				return
			}
		}
		if payload.Params != nil {
			updated.Params = strings.TrimSpace(*payload.Params)
		}
		if err := validateSavedFilterParams(updated.View, updated.Params); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_params")
			return
		}
		if err := s.db.UpsertSavedFilter(r.Context(), updated); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filter_save_failed")
			return
		}
		s.auditAdmin(r, "saved_filter.update", auditJSON(existing), auditJSON(updated))
		writeJSON(w, http.StatusOK, map[string]any{"filter": updated})
	case http.MethodDelete:
		if err := s.db.DeleteSavedFilter(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "saved_filter_delete_failed")
			return
		}
		s.auditAdmin(r, "saved_filter.delete", auditJSON(existing), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func validateSavedFilterParams(view, raw string) error {
	if len(raw) > 4096 {
		return errors.New("params exceed 4096 bytes")
	}
	params, err := url.ParseQuery(raw)
	if err != nil {
		return errors.New("params must be a URL-encoded query string")
	}
	if view != "xview" {
		return nil
	}

	allowed := map[string]bool{
		"window": true, "metric": true, "scale": true, "viewMode": true,
		"from": true, "to": true, "tz": true,
		"model": true, "models": true, "endpoint": true,
	}
	for key, values := range params {
		if !allowed[key] {
			return fmt.Errorf("unsupported xview parameter %q", key)
		}
		if len(values) > 1 {
			return fmt.Errorf("xview parameter %q must appear once", key)
		}
	}
	if err := validateSavedEnum(params.Get("window"), "window", "5m", "15m", "1h", "6h", "24h"); err != nil {
		return err
	}
	if err := validateSavedEnum(params.Get("metric"), "metric", "latency", "first_chunk", "tokens", "cost", "risk", "health"); err != nil {
		return err
	}
	if err := validateSavedEnum(params.Get("scale"), "scale", "log", "linear"); err != nil {
		return err
	}
	if err := validateSavedEnum(params.Get("viewMode"), "viewMode", "category", "model"); err != nil {
		return err
	}
	if params.Get("model") != "" && params.Get("models") != "" {
		return errors.New("xview model and models cannot be combined")
	}
	if len(params.Get("models")) > 2048 || len(params.Get("model")) > 512 {
		return errors.New("xview model filter is too long")
	}
	if len(params.Get("endpoint")) > 512 {
		return errors.New("xview endpoint filter is too long")
	}

	hasAbsoluteRange := params.Get("from") != "" || params.Get("to") != ""
	if hasAbsoluteRange && params.Get("window") != "" {
		return errors.New("xview window cannot be combined with from/to")
	}
	tz := strings.TrimSpace(params.Get("tz"))
	if tz != "" && !validSavedTimezone(tz) {
		return errors.New("invalid xview timezone")
	}
	loc := searchLocation(tz)
	from := parseRangeBound(params.Get("from"), loc, false)
	to := parseRangeBound(params.Get("to"), loc, true)
	if params.Get("from") != "" && from.IsZero() {
		return errors.New("invalid xview from value")
	}
	if params.Get("to") != "" && to.IsZero() {
		return errors.New("invalid xview to value")
	}
	if !from.IsZero() && !to.IsZero() && from.After(to) {
		return errors.New("xview from must not be after to")
	}
	return nil
}

func validateSavedEnum(value, field string, allowed ...string) error {
	if value == "" {
		return nil
	}
	for _, candidate := range allowed {
		if value == candidate {
			return nil
		}
	}
	return fmt.Errorf("invalid xview %s", field)
}

func validSavedTimezone(value string) bool {
	switch {
	case strings.EqualFold(value, "UTC"),
		strings.EqualFold(value, "KST"),
		strings.EqualFold(value, "Asia/Seoul"):
		return true
	}
	_, err := time.LoadLocation(value)
	return err == nil
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
	showRaw := s.canViewRawPrompts(r)
	if !showRaw {
		s.projectAdminAuditsForExternal(audits)
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
		actor := e.RuleID
		if !showRaw {
			projectionArgs := s.externalCredentialProjectionArgs()
			actor = audit.Redact(boundedExternalProviderText(actor, projectionArgs...))
			detail = audit.Redact(boundedExternalProviderText(detail, projectionArgs...))
		}
		_ = wr.Write([]string{e.CreatedAt.UTC().Format(time.RFC3339), "alert_event", actor, "alert.fire", "", detail})
	}
	wr.Flush()
}
