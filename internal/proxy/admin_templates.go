package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// validTemplateCategories are the standard AI-coding task buckets. "custom" is the
// catch-all. Unknown categories are coerced to "custom".
var validTemplateCategories = map[string]bool{
	"refactor": true, // 리팩터링
	"test":     true, // 테스트 생성
	"security": true, // 보안 점검
	"docs":     true, // 문서화
	"review":   true, // 코드 리뷰
	"custom":   true,
}

func normalizeTemplateCategory(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	if validTemplateCategories[c] {
		return c
	}
	return "custom"
}

// handleTemplates lists and creates centrally-managed prompt templates.
// GET /admin/templates[?enabled=1] · POST /admin/templates
func (s *Server) handleTemplates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		onlyEnabled := strings.TrimSpace(r.URL.Query().Get("enabled")) == "1"
		list, err := s.db.ListPromptTemplates(r.Context(), onlyEnabled)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "templates_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"templates": list, "categories": templateCategoryList()})
	case http.MethodPost:
		var p struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Category    string `json:"category"`
			Description string `json:"description"`
			Body        string `json:"body"`
			Enabled     *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		p.Body = strings.TrimSpace(p.Body)
		if p.Name == "" || p.Body == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and body are required", "invalid_request_error", "missing_fields")
			return
		}
		slug := slugify(p.ID)
		if slug == "" {
			slug = slugify(p.Name)
		}
		if slug == "" {
			writeOpenAIError(w, http.StatusBadRequest, "could not derive a slug id from name", "invalid_request_error", "invalid_slug")
			return
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		tmpl := store.PromptTemplate{
			ID:          slug,
			Name:        p.Name,
			Category:    normalizeTemplateCategory(p.Category),
			Description: strings.TrimSpace(p.Description),
			Body:        p.Body,
			Enabled:     enabled,
		}
		if err := s.db.UpsertPromptTemplate(r.Context(), tmpl); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
			return
		}
		s.auditAdmin(r, "template.upsert", "", auditJSON(map[string]any{"id": slug, "name": tmpl.Name, "category": tmpl.Category, "enabled": enabled}))
		writeJSON(w, http.StatusCreated, map[string]any{"template": tmpl})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleTemplateByID updates or deletes a single template.
// PATCH/DELETE /admin/templates/{id}
func (s *Server) handleTemplateByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/templates/")
	// /admin/templates/{id}/use — fetch a template's body and record a usage (the
	// "use from the market" action coding tools call).
	if idx := strings.Index(id, "/"); idx >= 0 {
		sub := id[idx+1:]
		id = id[:idx]
		if sub == "use" && r.Method == http.MethodPost {
			s.handleTemplateUse(w, r, id)
			return
		}
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid template id", "invalid_request_error", "invalid_template_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeletePromptTemplate(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_delete_failed")
			return
		}
		s.auditAdmin(r, "template.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		cur, found, err := s.db.GetPromptTemplate(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
			return
		}
		var p struct {
			Name        *string `json:"name"`
			Category    *string `json:"category"`
			Description *string `json:"description"`
			Body        *string `json:"body"`
			Enabled     *bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Name != nil {
			cur.Name = strings.TrimSpace(*p.Name)
		}
		if p.Category != nil {
			cur.Category = normalizeTemplateCategory(*p.Category)
		}
		if p.Description != nil {
			cur.Description = strings.TrimSpace(*p.Description)
		}
		if p.Body != nil {
			cur.Body = strings.TrimSpace(*p.Body)
		}
		if p.Enabled != nil {
			cur.Enabled = *p.Enabled
		}
		if err := s.db.UpsertPromptTemplate(r.Context(), cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
			return
		}
		s.auditAdmin(r, "template.update", "", auditJSON(map[string]any{"id": id, "category": cur.Category, "enabled": cur.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"template": cur})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleTemplateUse returns a template's body and records a usage, powering the
// "shared template market": teams discover standard prompts and pull them by id.
func (s *Server) handleTemplateUse(w http.ResponseWriter, r *http.Request, id string) {
	tmpl, found, err := s.db.GetPromptTemplate(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
		return
	}
	if !tmpl.Enabled {
		writeOpenAIError(w, http.StatusForbidden, "template is disabled", "invalid_request_error", "template_disabled")
		return
	}
	// Best-effort usage tracking (popularity ranking in the market).
	go func(id string) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.db.TouchPromptTemplate(ctx, id)
	}(id)
	writeJSON(w, http.StatusOK, map[string]any{
		"id": tmpl.ID, "name": tmpl.Name, "category": tmpl.Category,
		"description": tmpl.Description, "body": tmpl.Body,
	})
}

func templateCategoryList() []map[string]string {
	return []map[string]string{
		{"key": "refactor", "label": "리팩터링"},
		{"key": "test", "label": "테스트 생성"},
		{"key": "security", "label": "보안 점검"},
		{"key": "docs", "label": "문서화"},
		{"key": "review", "label": "코드 리뷰"},
		{"key": "custom", "label": "기타"},
	}
}
