package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleText2SQLAdmin serves the Text2SQL admin tab data: recent query logs +
// aggregate stats over a window.
// GET /admin/text2sql?window=7d
func (s *Server) handleText2SQLAdmin(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	logs, err := s.db.ListText2SQLLogs(r.Context(), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_logs_failed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	stats, err := s.db.Text2SQLStatsSince(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_stats_failed")
		return
	}
	schemas, _ := s.db.ListText2SQLSchemas(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"schemas": schemas,
		"enabled": s.cfg.Text2SQL.Enabled,
		"profiles": []map[string]string{
			{"model": "vibe/text2sql-preview", "mode": "preview", "upstream": s.cfg.Text2SQL.PreviewModel},
			{"model": "vibe/text2sql-execute", "mode": "execute", "upstream": s.cfg.Text2SQL.ExecuteModel},
			{"model": "vibe/text2sql-accurate", "mode": "preview", "upstream": s.cfg.Text2SQL.AccurateModel},
			{"model": "vibe/text2sql-local", "mode": "preview", "upstream": s.cfg.Text2SQL.LocalModel},
			{"model": "vibe/text2sql-auto", "mode": "auto", "upstream": "(complexity 기반)"},
		},
		"stats": stats,
		"logs":  logs,
	})
}

// handleText2SQLSchemas manages the Text2SQL schema catalog (schema context + table
// allowlist + team scope).
// GET /admin/text2sql/schemas · POST {name,team,dialect,schema_text,allowed_tables[],is_default,enabled} · DELETE ?name=
func (s *Server) handleText2SQLSchemas(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		schemas, err := s.db.ListText2SQLSchemas(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schemas_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"schemas": schemas})
	case http.MethodPost:
		var p struct {
			Name          string   `json:"name"`
			Team          string   `json:"team"`
			Dialect       string   `json:"dialect"`
			SchemaText    string   `json:"schema_text"`
			AllowedTables []string `json:"allowed_tables"`
			IsDefault     *bool    `json:"is_default"`
			Enabled       *bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" || strings.TrimSpace(p.SchemaText) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and schema_text are required", "invalid_request_error", "missing_fields")
			return
		}
		sc := store.Text2SQLSchema{
			Name: p.Name, Team: strings.TrimSpace(p.Team), Dialect: strings.TrimSpace(p.Dialect),
			SchemaText: p.SchemaText, AllowedTables: p.AllowedTables, Enabled: true,
		}
		if p.Enabled != nil {
			sc.Enabled = *p.Enabled
		}
		if p.IsDefault != nil {
			sc.IsDefault = *p.IsDefault
		}
		if err := s.db.UpsertText2SQLSchema(r.Context(), sc); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schema_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.schema.upsert", "", auditJSON(map[string]any{"name": sc.Name, "team": sc.Team, "tables": len(sc.AllowedTables)}))
		writeJSON(w, http.StatusCreated, map[string]any{"schema": sc})
	case http.MethodDelete:
		name := strings.TrimSpace(r.URL.Query().Get("name"))
		if name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name query param is required", "invalid_request_error", "missing_name")
			return
		}
		if err := s.db.DeleteText2SQLSchema(r.Context(), name); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schema_delete_failed")
			return
		}
		s.auditAdmin(r, "text2sql.schema.delete", auditJSON(map[string]string{"name": name}), "")
		writeJSON(w, http.StatusOK, map[string]string{"name": name, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
