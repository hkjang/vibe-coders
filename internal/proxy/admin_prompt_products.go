package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handlePromptProductCandidates surfaces recurring prompt clusters (by fingerprint)
// that are good candidates to promote into a reusable "product", annotating each with
// whether it has already been productized. Read-only.
// GET /admin/prompt-products/candidates?window=7d&limit=50
func (s *Server) handlePromptProductCandidates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	clusters, err := s.db.PromptFingerprints(r.Context(), since, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "candidates_failed")
		return
	}
	productized, err := s.db.PromptProductFingerprints(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "candidates_failed")
		return
	}
	candidates := make([]map[string]any, 0, len(clusters))
	for _, c := range clusters {
		candidates = append(candidates, map[string]any{
			"fingerprint":     c.Fingerprint,
			"task_type":       c.TaskType,
			"requests":        c.Requests,
			"avg_cost_krw":    c.AvgCostKRW,
			"total_cost_krw":  c.TotalCostKRW,
			"success_rate":    c.SuccessRate,
			"top_model":       c.TopModel,
			"cheapest_model":  c.CheapestModel,
			"sample_prompt":   c.SamplePrompt,
			"last_seen":       c.LastSeen,
			"productized":     productized[c.Fingerprint],
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidates": candidates})
}

// handlePromptProducts is the Prompt-to-Product registry.
// GET → list products (with template adoption counters);
// POST {name, template, description?, category?, source_fingerprint?, window?} →
//
//	promote: create/replace a prompt template and register it as a product, snapshotting
//	the source cluster's reach;
//
// DELETE ?id= → remove the product (the underlying template is left intact).
func (s *Server) handlePromptProducts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		products, err := s.db.ListPromptProducts(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_products_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"products": products})
	case http.MethodPost:
		var payload struct {
			Name              string `json:"name"`
			Description       string `json:"description"`
			Category          string `json:"category"`
			Template          string `json:"template"`
			SourceFingerprint string `json:"source_fingerprint"`
			Window            string `json:"window"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		name := strings.TrimSpace(payload.Name)
		body := strings.TrimSpace(payload.Template)
		if name == "" || body == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and template are required", "invalid_request_error", "missing_fields")
			return
		}
		slug := slugify(name)
		if slug == "" {
			writeOpenAIError(w, http.StatusBadRequest, "could not derive a slug id from name", "invalid_request_error", "invalid_slug")
			return
		}
		category := strings.TrimSpace(payload.Category)
		if category == "" {
			category = "product"
		}
		// Create/replace the canonical template that backs this product.
		tmpl := store.PromptTemplate{
			ID: slug, Name: name, Category: category, Description: payload.Description, Body: body, Enabled: true,
		}
		if err := s.db.UpsertPromptTemplate(r.Context(), tmpl); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "template_save_failed")
			return
		}
		// Snapshot the source cluster's reach if a fingerprint was provided.
		var reqCount, distinctUsers int64
		fp := strings.TrimSpace(payload.SourceFingerprint)
		if fp != "" {
			since := parseWindow(payload.Window, 30*24*time.Hour, "day")
			reqCount, distinctUsers, _ = s.db.PromptFingerprintReach(r.Context(), fp, since)
		}
		product := store.PromptProduct{
			ID: newID("pp"), Name: name, Description: payload.Description, Category: category,
			SourceFingerprint: fp, TemplateID: slug, RequestCount: reqCount, DistinctUsers: distinctUsers,
			CreatedBy: adminID(r),
		}
		if err := s.db.UpsertPromptProduct(r.Context(), product); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_product_save_failed")
			return
		}
		s.auditAdmin(r, "prompt.product.promote", product.ID, auditJSON(map[string]any{"name": name, "template_id": slug, "fingerprint": fp, "requests": reqCount}))
		writeJSON(w, http.StatusOK, map[string]any{"product": product, "template": tmpl})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeletePromptProduct(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_product_delete_failed")
			return
		}
		s.auditAdmin(r, "prompt.product.delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
