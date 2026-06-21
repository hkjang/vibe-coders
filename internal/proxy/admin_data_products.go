package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// dataProductVisibleToTeam reports whether a data product is visible to a team. An empty
// allowed_teams list means every team may see it (mirrors skillVisibleToTeam).
func dataProductVisibleToTeam(p store.DataProduct, team string) bool {
	if len(p.AllowedTeams) == 0 {
		return true
	}
	return containsFold(p.AllowedTeams, team)
}

var dataProductSourceTypes = map[string]bool{"saved_report": true, "metric": true, "golden_query": true, "custom": true}

// handleAdminDataProducts manages the data product catalog (admin).
// GET    /admin/data-products[?status=]   list
// POST   /admin/data-products             upsert (publish by setting status=published)
// DELETE /admin/data-products?id=..        delete
func (s *Server) handleAdminDataProducts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		items, err := s.db.ListDataProducts(ctx, strings.TrimSpace(r.URL.Query().Get("status")))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"products": items})
	case http.MethodPost:
		var p struct {
			ID           string   `json:"id"`
			ProductKey   string   `json:"product_key"`
			NameKO       string   `json:"name_ko"`
			Description  string   `json:"description"`
			SourceType   string   `json:"source_type"`
			SourceRef    string   `json:"source_ref"`
			Owner        string   `json:"owner"`
			AllowedTeams []string `json:"allowed_teams"`
			Sensitivity  string   `json:"sensitivity"`
			Status       string   `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		key := strings.TrimSpace(p.ProductKey)
		if key == "" || strings.TrimSpace(p.NameKO) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "product_key and name_ko are required", "invalid_request_error", "missing_fields")
			return
		}
		sourceType := strings.TrimSpace(p.SourceType)
		if sourceType == "" {
			sourceType = "custom"
		}
		if !dataProductSourceTypes[sourceType] {
			writeOpenAIError(w, http.StatusBadRequest, "source_type must be saved_report|metric|golden_query|custom", "invalid_request_error", "bad_source_type")
			return
		}
		status := strings.TrimSpace(p.Status)
		switch status {
		case "", "draft":
			status = "draft"
		case "published", "archived":
		default:
			writeOpenAIError(w, http.StatusBadRequest, "status must be draft|published|archived", "invalid_request_error", "bad_status")
			return
		}
		dp := store.DataProduct{
			ID: firstNonEmpty(strings.TrimSpace(p.ID), newID("dprod")), ProductKey: key, NameKO: strings.TrimSpace(p.NameKO),
			Description: p.Description, SourceType: sourceType, SourceRef: strings.TrimSpace(p.SourceRef), Owner: p.Owner,
			AllowedTeams: p.AllowedTeams, Sensitivity: strings.TrimSpace(p.Sensitivity), Status: status, UpdatedBy: adminID(r),
		}
		if err := s.db.UpsertDataProduct(ctx, dp); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "upsert_failed")
			return
		}
		s.auditAdmin(r, "data_product_upsert", "", auditJSON(map[string]any{"product_key": key, "status": status, "source_type": sourceType}))
		writeJSON(w, http.StatusOK, map[string]any{"product_key": key, "ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param required", "invalid_request_error", "no_id")
			return
		}
		if err := s.db.DeleteDataProduct(ctx, id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "data_product_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminDataProductCandidates suggests data products to publish from recurring Text2SQL
// questions (the report-candidate miner). Raw SQL is never returned — only the question, its
// frequency, and the recommended product shape.
// GET /admin/data-products/candidates[?window=&min_count=]
func (s *Server) handleAdminDataProductCandidates(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := intQuery(r, "min_count", 3)
	cands, err := s.db.Text2SQLReportCandidates(r.Context(), since, minCount, 25)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "candidates_failed")
		return
	}
	out := make([]map[string]any, 0, len(cands))
	for _, c := range cands {
		out = append(out, map[string]any{
			"question": c.Question, "count": c.Count, "last_seen": c.LastSeen,
			"recommended_product": c.RecommendedProduct,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": out, "since": since.UTC().Format(time.RFC3339),
		"note": "반복 Text2SQL 질문을 데이터 상품 후보로 분류합니다(원문 SQL 미노출). 후보를 데이터 상품으로 발행하세요.",
	})
}

// handleAdminDataProductRequests lists access requests (GET ?product=) and decides one
// (POST {id, action: approve|deny}). admin gated.
// GET|POST /admin/data-products/requests
func (s *Server) handleAdminDataProductRequests(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		reqs, err := s.db.ListDataProductAccessRequests(ctx, strings.TrimSpace(r.URL.Query().Get("product")))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"requests": reqs})
	case http.MethodPost:
		var p struct {
			ID     string `json:"id"`
			Action string `json:"action"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.ID) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id is required", "invalid_request_error", "no_id")
			return
		}
		approve := strings.EqualFold(strings.TrimSpace(p.Action), "approve")
		if err := s.db.DecideDataProductAccessRequest(ctx, p.ID, approve, adminID(r)); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "decision_failed")
			return
		}
		status := "denied"
		if approve {
			status = "approved"
		}
		s.auditAdmin(r, "data_product_request."+status, p.ID, "")
		writeJSON(w, http.StatusOK, map[string]any{"id": p.ID, "status": status})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
