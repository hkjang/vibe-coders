package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const deprecationTTL = 30 * time.Second

type deprecationSnapshot struct {
	items     []store.ModelDeprecation
	fetchedAt time.Time
}

func (s *Server) deprecationSnapshot(ctx context.Context) []store.ModelDeprecation {
	if cached := s.deprecations.Load(); cached != nil && time.Since(cached.fetchedAt) < deprecationTTL {
		return cached.items
	}
	snap := &deprecationSnapshot{fetchedAt: time.Now()}
	if list, err := s.db.ListModelDeprecations(ctx); err == nil {
		snap.items = list
	}
	s.deprecations.Store(snap)
	return snap.items
}

func (s *Server) invalidateDeprecationCache() { s.deprecations.Store(nil) }

// matchModelDeprecation returns the first deprecation whose glob matches the model.
func (s *Server) matchModelDeprecation(ctx context.Context, model string) (store.ModelDeprecation, bool) {
	model = strings.TrimSpace(model)
	if model == "" {
		return store.ModelDeprecation{}, false
	}
	for _, d := range s.deprecationSnapshot(ctx) {
		if matchGlob(strings.ToLower(strings.TrimSpace(d.ModelGlob)), strings.ToLower(model)) {
			return d, true
		}
	}
	return store.ModelDeprecation{}, false
}

// sunsetReached reports whether the (YYYY-MM-DD, UTC) sunset date is today or in the past.
// An empty/invalid date means warn-only indefinitely (never reached).
func sunsetReached(sunsetDate string, now time.Time) bool {
	sunsetDate = strings.TrimSpace(sunsetDate)
	if sunsetDate == "" {
		return false
	}
	d, err := time.Parse("2006-01-02", sunsetDate)
	if err != nil {
		return false
	}
	return !now.UTC().Before(d)
}

// stepDeprecation annotates (and after sunset, rewrites or blocks) requests to deprecated
// models. Runs after skill, before governance, so the effective model is known and any
// rewrite flows to provider selection. Chat POST only.
func (rc *requestPipeline) stepDeprecation() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost {
		return true
	}
	dep, ok := s.matchModelDeprecation(r.Context(), rc.meta.Request.Model)
	if !ok {
		return true
	}
	w.Header().Set("X-Model-Deprecated", rc.meta.Request.Model)
	if dep.Replacement != "" {
		w.Header().Set("X-Model-Replacement", dep.Replacement)
	}
	if dep.SunsetDate != "" {
		w.Header().Set("X-Model-Sunset", dep.SunsetDate)
	}
	if dep.Message != "" {
		w.Header().Set("X-Model-Deprecation-Message", dep.Message)
	}

	if !sunsetReached(dep.SunsetDate, time.Now()) {
		return true // warn-only: headers set, request proceeds unchanged
	}
	// Sunset reached.
	if dep.Replacement == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model '"+rc.meta.Request.Model+"' is retired (sunset "+dep.SunsetDate+")", "invalid_request_error", "model_sunset")
		return false
	}
	rc.body = rewriteModelField(rc.body, dep.Replacement)
	w.Header().Set("X-Model-Sunset-Rewritten", dep.Replacement)
	rc.meta.Request.Model = dep.Replacement
	return true
}

type deprecationPayload struct {
	ModelGlob   string `json:"model_glob"`
	Replacement string `json:"replacement"`
	SunsetDate  string `json:"sunset_date"`
	Message     string `json:"message"`
}

// handleModelDeprecations lists (GET) and creates/updates (POST) model deprecations.
// GET|POST /admin/model-deprecations
func (s *Server) handleModelDeprecations(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListModelDeprecations(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "deprecations_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deprecations": list})
	case http.MethodPost:
		var p deprecationPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.ModelGlob) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "model_glob is required", "invalid_request_error", "missing_model_glob")
			return
		}
		if sd := strings.TrimSpace(p.SunsetDate); sd != "" {
			if _, err := time.Parse("2006-01-02", sd); err != nil {
				writeOpenAIError(w, http.StatusBadRequest, "sunset_date must be YYYY-MM-DD", "invalid_request_error", "invalid_sunset_date")
				return
			}
		}
		saved, err := s.db.UpsertModelDeprecation(r.Context(), store.ModelDeprecation{
			ModelGlob: p.ModelGlob, Replacement: strings.TrimSpace(p.Replacement),
			SunsetDate: strings.TrimSpace(p.SunsetDate), Message: strings.TrimSpace(p.Message),
		})
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "deprecation_save_failed")
			return
		}
		s.invalidateDeprecationCache()
		s.auditAdmin(r, "model_deprecation.upsert", saved.ModelGlob, auditJSON(saved))
		writeJSON(w, http.StatusCreated, map[string]any{"deprecation": saved})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleModelDeprecationByID deletes one deprecation.
// DELETE /admin/model-deprecations/{id}
func (s *Server) handleModelDeprecationByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/model-deprecations/"), "/")
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "deprecation id required", "invalid_request_error", "missing_id")
		return
	}
	if err := s.db.DeleteModelDeprecation(r.Context(), id); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "deprecation_delete_failed")
		return
	}
	s.invalidateDeprecationCache()
	s.auditAdmin(r, "model_deprecation.delete", id, "")
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
}
