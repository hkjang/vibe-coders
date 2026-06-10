package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

func (s *Server) handleMCPUpstreams(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListMCPUpstreams(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstreams_failed")
			return
		}
		// surface last tool-discovery error per upstream from the cached snapshot
		errs := map[string]string{}
		if snap := s.mcpTools.Load(); snap != nil {
			errs = snap.errors
		}
		writeJSON(w, http.StatusOK, map[string]any{"upstreams": list, "discovery_errors": errs})
	case http.MethodPost:
		var p struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			URL       string `json:"url"`
			AuthToken string `json:"auth_token"`
			Enabled   *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		p.URL = strings.TrimSpace(p.URL)
		if p.Name == "" || p.URL == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and url are required", "invalid_request_error", "missing_fields")
			return
		}
		if !strings.HasPrefix(p.URL, "http://") && !strings.HasPrefix(p.URL, "https://") {
			writeOpenAIError(w, http.StatusBadRequest, "url must be http(s)", "invalid_request_error", "invalid_url")
			return
		}
		slug := slugify(p.ID)
		if slug == "" {
			slug = slugify(p.Name)
		}
		if slug == "" {
			writeOpenAIError(w, http.StatusBadRequest, "could not derive a slug id", "invalid_request_error", "invalid_slug")
			return
		}
		encAuth := ""
		if strings.TrimSpace(p.AuthToken) != "" {
			enc, err := s.secrets.Encrypt(strings.TrimSpace(p.AuthToken))
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "encrypt_failed")
				return
			}
			encAuth = enc
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		up := store.MCPUpstream{ID: slug, Name: p.Name, URL: p.URL, EncryptedAuth: encAuth, Enabled: enabled}
		if err := s.db.UpsertMCPUpstream(r.Context(), up); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_save_failed")
			return
		}
		s.resetMCPUpstream(slug)
		s.auditAdmin(r, "mcp_upstream.upsert", "", auditJSON(map[string]any{"id": slug, "name": up.Name, "url": up.URL, "enabled": enabled, "auth": encAuth != ""}))
		writeJSON(w, http.StatusCreated, map[string]any{"upstream": map[string]any{"id": slug, "name": up.Name, "url": up.URL, "enabled": enabled, "has_auth": encAuth != ""}})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleMCPUpstreamByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/mcp/upstreams/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid upstream id", "invalid_request_error", "invalid_upstream_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeleteMCPUpstream(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_delete_failed")
			return
		}
		s.resetMCPUpstream(id)
		s.auditAdmin(r, "mcp_upstream.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		cur, found, err := s.db.GetMCPUpstream(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "upstream not found", "invalid_request_error", "upstream_not_found")
			return
		}
		var p struct {
			Name      *string `json:"name"`
			URL       *string `json:"url"`
			AuthToken *string `json:"auth_token"`
			Enabled   *bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Name != nil {
			cur.Name = strings.TrimSpace(*p.Name)
		}
		if p.URL != nil {
			cur.URL = strings.TrimSpace(*p.URL)
		}
		if p.Enabled != nil {
			cur.Enabled = *p.Enabled
		}
		if p.AuthToken != nil {
			if strings.TrimSpace(*p.AuthToken) == "" {
				cur.EncryptedAuth = ""
			} else {
				enc, eerr := s.secrets.Encrypt(strings.TrimSpace(*p.AuthToken))
				if eerr != nil {
					writeOpenAIError(w, http.StatusInternalServerError, eerr.Error(), "server_error", "encrypt_failed")
					return
				}
				cur.EncryptedAuth = enc
			}
		}
		if err := s.db.UpsertMCPUpstream(r.Context(), cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_upstream_save_failed")
			return
		}
		s.resetMCPUpstream(id)
		s.auditAdmin(r, "mcp_upstream.update", "", auditJSON(map[string]any{"id": id, "enabled": cur.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"upstream": map[string]any{"id": cur.ID, "name": cur.Name, "url": cur.URL, "enabled": cur.Enabled, "has_auth": cur.EncryptedAuth != ""}})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// resetMCPUpstream drops cached session + tool catalog so a change takes effect now.
func (s *Server) resetMCPUpstream(id string) {
	s.mcpConns.Delete(id)
	s.invalidateMCPToolsCache()
}
