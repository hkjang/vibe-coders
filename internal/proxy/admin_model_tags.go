package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// handleAdminModelTags lists or upserts model usage tags (good_for / avoid_for / risk_note).
// GET/POST /admin/model-tags
func (s *Server) handleAdminModelTags(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		tags, err := s.db.ListModelUsageTags(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
	case http.MethodPost:
		var p store.ModelUsageTag
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Model) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "model is required", "invalid_request_error", "bad_request")
			return
		}
		p.Model = strings.TrimSpace(p.Model)
		p.UpdatedBy = s.skillActor(r)
		if err := s.db.UpsertModelUsageTag(r.Context(), p); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "save_failed")
			return
		}
		s.auditAdmin(r, "model_tag.upsert", p.Model, auditJSON(map[string]any{"good_for": p.GoodFor, "avoid_for": p.AvoidFor}))
		writeJSON(w, http.StatusOK, p)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminModelTagByID deletes one model's tags. DELETE /admin/model-tags/{model}
func (s *Server) handleAdminModelTagByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	model := strings.TrimPrefix(r.URL.Path, "/admin/model-tags/")
	if model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model required", "invalid_request_error", "bad_request")
		return
	}
	if err := s.db.DeleteModelUsageTag(r.Context(), model); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
}

// handleModelTags is the read-only view for any authenticated caller (used by the multi-model
// console + personal "recommended models" surfaces). GET /v1/model-tags
func (s *Server) handleModelTags(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.currentAccessClaims(r); !ok && !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	tags, err := s.db.ListModelUsageTags(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}
