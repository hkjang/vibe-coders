package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

func (s *Server) handleKnowledge(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListKnowledge(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "knowledge_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"snippets": list})
	case http.MethodPost:
		var p struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Content string `json:"content"`
			Enabled *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		p.Content = strings.TrimSpace(p.Content)
		if p.Name == "" || p.Content == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and content are required", "invalid_request_error", "missing_fields")
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
		snippet := store.KnowledgeSnippet{
			ID:            slug,
			Name:          p.Name,
			Content:       p.Content,
			Enabled:       enabled,
			TokenEstimate: audit.EstimateTokens(p.Content),
		}
		if err := s.db.UpsertKnowledge(r.Context(), snippet); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "knowledge_save_failed")
			return
		}
		s.invalidateKnowledgeCache()
		s.auditAdmin(r, "knowledge.upsert", "", auditJSON(map[string]any{"id": slug, "name": snippet.Name, "tokens": snippet.TokenEstimate, "enabled": enabled}))
		writeJSON(w, http.StatusCreated, map[string]any{"snippet": snippet})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleKnowledgeByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/knowledge/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid snippet id", "invalid_request_error", "invalid_snippet_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeleteKnowledge(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "knowledge_delete_failed")
			return
		}
		s.invalidateKnowledgeCache()
		s.auditAdmin(r, "knowledge.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		snippets, err := s.db.ListKnowledge(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "knowledge_lookup_failed")
			return
		}
		var cur *store.KnowledgeSnippet
		for i := range snippets {
			if snippets[i].ID == id {
				cur = &snippets[i]
				break
			}
		}
		if cur == nil {
			writeOpenAIError(w, http.StatusNotFound, "snippet not found", "invalid_request_error", "snippet_not_found")
			return
		}
		var p struct {
			Name    *string `json:"name"`
			Content *string `json:"content"`
			Enabled *bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Name != nil {
			cur.Name = strings.TrimSpace(*p.Name)
		}
		if p.Content != nil {
			cur.Content = strings.TrimSpace(*p.Content)
			cur.TokenEstimate = audit.EstimateTokens(cur.Content)
		}
		if p.Enabled != nil {
			cur.Enabled = *p.Enabled
		}
		if err := s.db.UpsertKnowledge(r.Context(), *cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "knowledge_save_failed")
			return
		}
		s.invalidateKnowledgeCache()
		s.auditAdmin(r, "knowledge.update", "", auditJSON(map[string]any{"id": id, "enabled": cur.Enabled, "tokens": cur.TokenEstimate}))
		writeJSON(w, http.StatusOK, map[string]any{"snippet": cur})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// slugify lowercases and reduces a string to [a-z0-9_-], collapsing runs to a single
// dash, so a snippet id is safe to embed in a {{kb:...}} reference.
func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == '_' || r == '-':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
