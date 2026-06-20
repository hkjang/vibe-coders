package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
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

var validAssetStatuses = map[string]bool{
	"draft":    true,
	"pending":  true,
	"approved": true,
	"standard": true,
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
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Category    string   `json:"category"`
			Description string   `json:"description"`
			Body        string   `json:"body"`
			Enabled     *bool    `json:"enabled"`
			Tags        []string `json:"tags"`
			Status      string   `json:"status"`
			Note        string   `json:"note"`
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
		status := "draft"
		if validAssetStatuses[p.Status] {
			status = p.Status
		}
		tmpl := store.PromptTemplate{
			ID:          slug,
			Name:        p.Name,
			Category:    normalizeTemplateCategory(p.Category),
			Description: strings.TrimSpace(p.Description),
			Body:        p.Body,
			Enabled:     enabled,
			Tags:        p.Tags,
			Status:      status,
			Note:        strings.TrimSpace(p.Note),
		}
		_, existed, _ := s.db.GetPromptTemplate(r.Context(), slug)
		if err := s.db.UpsertPromptTemplate(r.Context(), tmpl); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
			return
		}
		action := "create"
		if existed {
			action = "edit"
		}
		s.recordTemplateSnapshot(r, tmpl, action, "")
		s.auditAdmin(r, "template.upsert", "", auditJSON(map[string]any{"id": slug, "name": tmpl.Name, "category": tmpl.Category, "enabled": enabled, "status": status}))
		writeJSON(w, http.StatusCreated, map[string]any{"template": tmpl})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleTemplateByID updates or deletes a single template.
// PATCH/DELETE /admin/templates/{id}
// POST /admin/templates/{id}/use       — fetch + record usage
// POST /admin/templates/{id}/approve   — change status
// POST /admin/templates/{id}/submit    — submit for review (draft→pending)
func (s *Server) handleTemplateByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/templates/")
	if idx := strings.Index(id, "/"); idx >= 0 {
		sub := id[idx+1:]
		id = id[:idx]
		switch sub {
		case "use":
			if r.Method == http.MethodPost {
				s.handleTemplateUse(w, r, id)
				return
			}
		case "approve":
			if r.Method == http.MethodPost {
				s.handleTemplateApprove(w, r, id)
				return
			}
		case "submit":
			if r.Method == http.MethodPost {
				s.handleTemplateSubmit(w, r, id)
				return
			}
		case "history":
			if r.Method == http.MethodGet {
				s.handleTemplateHistory(w, r, id)
				return
			}
		case "rollback":
			if r.Method == http.MethodPost {
				s.handleTemplateRollback(w, r, id)
				return
			}
		case "usage":
			if r.Method == http.MethodGet {
				s.handleTemplateUsage(w, r, id)
				return
			}
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
		prevBody := cur.Body
		var p struct {
			Name        *string  `json:"name"`
			Category    *string  `json:"category"`
			Description *string  `json:"description"`
			Body        *string  `json:"body"`
			Enabled     *bool    `json:"enabled"`
			Tags        []string `json:"tags"`
			Note        *string  `json:"note"`
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
		if p.Tags != nil {
			cur.Tags = p.Tags
		}
		if p.Note != nil {
			cur.Note = strings.TrimSpace(*p.Note)
		}
		if err := s.db.UpsertPromptTemplate(r.Context(), cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
			return
		}
		// Snapshot a new version only when the body actually changed — field-only edits
		// (rename, retag) don't create version noise.
		if cur.Body != prevBody {
			s.recordTemplateSnapshot(r, cur, "edit", "")
		}
		s.auditAdmin(r, "template.update", "", auditJSON(map[string]any{"id": id, "category": cur.Category, "enabled": cur.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"template": cur})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleTemplateApprove changes a template's approval status.
// POST /admin/templates/{id}/approve  body: {"status":"approved","note":"..."}
func (s *Server) handleTemplateApprove(w http.ResponseWriter, r *http.Request, id string) {
	var p struct {
		Status string `json:"status"` // approved | standard | draft (reject)
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if !validAssetStatuses[p.Status] {
		writeOpenAIError(w, http.StatusBadRequest, "status must be draft|pending|approved|standard", "invalid_request_error", "invalid_status")
		return
	}
	cur, found, err := s.db.GetPromptTemplate(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
		return
	}
	from := cur.Status
	by := adminID(r)
	note := strings.TrimSpace(p.Note)
	if err := s.db.ApprovePromptTemplate(r.Context(), id, p.Status, by, note); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_approve_failed")
		return
	}
	action := "approve"
	switch {
	case p.Status == "standard":
		action = "promote"
	case p.Status == "draft" && (from == "pending" || from == "approved" || from == "standard"):
		action = "reject"
	}
	s.recordTemplateStatusEvent(r, id, action, from, p.Status, note, by)
	// 골든 회귀 연결: promoting to 조직 표준 auto-registers a golden regression case so the
	// standard prompt is covered by the existing Golden Prompt regression suite.
	if p.Status == "standard" {
		s.registerGoldenFromTemplate(r, cur)
	}
	s.auditAdmin(r, "template.approve", "", auditJSON(map[string]any{"id": id, "status": p.Status, "by": by}))
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": p.Status})
}

// handleTemplateSubmit transitions a template from draft to pending (submit for review).
// POST /admin/templates/{id}/submit
func (s *Server) handleTemplateSubmit(w http.ResponseWriter, r *http.Request, id string) {
	cur, found, err := s.db.GetPromptTemplate(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
		return
	}
	by := adminID(r)
	from := cur.Status
	if err := s.db.ApprovePromptTemplate(r.Context(), id, "pending", by, ""); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_submit_failed")
		return
	}
	s.recordTemplateStatusEvent(r, id, "submit", from, "pending", "", by)
	// 승인 대기 알림: notify reviewers that an asset is awaiting approval.
	s.notifyMattermost(r.Context(), "approval", "프롬프트 자산 검토 요청: '"+cur.Name+"' (id "+id+") — 제출자 "+by)
	s.auditAdmin(r, "template.submit", "", auditJSON(map[string]string{"id": id}))
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "pending"})
}

// handleTemplateHistory returns a template's full change/version log.
// GET /admin/templates/{id}/history
func (s *Server) handleTemplateHistory(w http.ResponseWriter, r *http.Request, id string) {
	hist, err := s.db.ListPromptTemplateHistory(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_history_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": hist})
}

// handleTemplateRollback restores a template's body/fields to a prior version snapshot,
// recording the restore as a new version. POST /admin/templates/{id}/rollback {"version":N}
func (s *Server) handleTemplateRollback(w http.ResponseWriter, r *http.Request, id string) {
	var p struct {
		Version int64 `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	snap, found, err := s.db.GetPromptTemplateVersionSnapshot(r.Context(), id, p.Version)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_version_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "version snapshot not found", "invalid_request_error", "version_not_found")
		return
	}
	cur, found, err := s.db.GetPromptTemplate(r.Context(), id)
	if err != nil || !found {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
		return
	}
	cur.Name = snap.Name
	cur.Category = snap.Category
	cur.Description = snap.Description
	cur.Body = snap.Body
	cur.Tags = snap.Tags
	if err := s.db.UpsertPromptTemplate(r.Context(), cur); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
		return
	}
	s.recordTemplateSnapshot(r, cur, "rollback", "v"+strconv.FormatInt(p.Version, 10)+" 복원")
	s.auditAdmin(r, "template.rollback", "", auditJSON(map[string]any{"id": id, "version": p.Version}))
	writeJSON(w, http.StatusOK, map[string]any{"template": cur, "restored_from": p.Version})
}

// handleTemplateUsage returns per-team usage of an asset (90-day window), matching by
// asset id (header attribution) and display name. GET /admin/templates/{id}/usage
func (s *Server) handleTemplateUsage(w http.ResponseWriter, r *http.Request, id string) {
	cur, found, err := s.db.GetPromptTemplate(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "template not found", "invalid_request_error", "template_not_found")
		return
	}
	usage, err := s.db.PromptAssetUsage(r.Context(), []string{cur.ID, cur.Name})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_usage_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": usage})
}

// recordTemplateSnapshot appends a version snapshot (create/edit/rollback) to the history log.
func (s *Server) recordTemplateSnapshot(r *http.Request, t store.PromptTemplate, action, note string) {
	_, _ = s.db.AddPromptTemplateHistory(r.Context(), store.PromptTemplateHistory{
		ID:          newID("pth"),
		TemplateID:  t.ID,
		Action:      action,
		Name:        t.Name,
		Category:    t.Category,
		Description: t.Description,
		Body:        t.Body,
		Tags:        t.Tags,
		ToStatus:    t.Status,
		Note:        note,
		Actor:       adminID(r),
		HasSnapshot: true,
	})
}

// recordTemplateStatusEvent appends a non-snapshot status transition to the history log.
func (s *Server) recordTemplateStatusEvent(r *http.Request, id, action, from, to, note, by string) {
	_, _ = s.db.AddPromptTemplateHistory(r.Context(), store.PromptTemplateHistory{
		ID:         newID("pth"),
		TemplateID: id,
		Action:     action,
		FromStatus: from,
		ToStatus:   to,
		Note:       note,
		Actor:      by,
	})
}

// registerGoldenFromTemplate registers a Golden Prompt regression case for a template
// promoted to 조직 표준, so the standard prompt is exercised by the regression suite.
func (s *Server) registerGoldenFromTemplate(r *http.Request, t store.PromptTemplate) {
	tags := append([]string{"prompt-asset", t.Category}, t.Tags...)
	_ = s.db.UpsertGoldenPrompt(r.Context(), store.GoldenPrompt{
		ID:     "asset_" + t.ID,
		Name:   "[자산] " + t.Name,
		Prompt: t.Body,
		Tags:   tags,
	})
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
		"tags": tmpl.Tags, "status": tmpl.Status,
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
