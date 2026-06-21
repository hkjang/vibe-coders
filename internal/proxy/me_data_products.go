package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// handleMeDataProducts lists published data products the caller's team can see, plus the
// caller's own access-request status. Any authenticated user. GET /me/data-products
func (s *Server) handleMeDataProducts(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	products, err := s.db.ListDataProducts(r.Context(), "published")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	// The caller's existing requests, keyed by product, to show status inline.
	myReqStatus := map[string]string{}
	if reqs, err := s.db.ListDataProductAccessRequests(r.Context(), ""); err == nil {
		for _, rq := range reqs {
			if rq.UserID == claims.Subject {
				myReqStatus[rq.ProductKey] = rq.Status
			}
		}
	}

	available, requestable := []map[string]any{}, []map[string]any{}
	for _, p := range products {
		row := map[string]any{
			"product_key": p.ProductKey, "name_ko": p.NameKO, "description": p.Description,
			"source_type": p.SourceType, "owner": p.Owner, "sensitivity": p.Sensitivity,
			"request_status": myReqStatus[p.ProductKey],
		}
		if dataProductVisibleToTeam(p, claims.TeamID) {
			available = append(available, row)
		} else {
			requestable = append(requestable, row)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": available, "requestable": requestable, "team": claims.TeamID})
}

// handleMeDataProductAccess records an access request for a data product.
// POST /me/data-products/{key}/request-access {reason}
func (s *Server) handleMeDataProductAccess(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/me/data-products/")
	idx := strings.LastIndex(rest, "/")
	if idx < 0 || r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusBadRequest, "expected POST /me/data-products/{key}/request-access", "invalid_request_error", "bad_request")
		return
	}
	key, action := rest[:idx], rest[idx+1:]
	if key == "" || action != "request-access" {
		writeOpenAIError(w, http.StatusBadRequest, "expected POST /me/data-products/{key}/request-access", "invalid_request_error", "bad_request")
		return
	}
	p, found, _ := s.db.GetDataProduct(r.Context(), key)
	if !found || p.Status != "published" {
		writeOpenAIError(w, http.StatusNotFound, "data product not found", "invalid_request_error", "not_found")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	rq := store.DataProductAccessRequest{
		ID: newID("dpreq"), ProductKey: p.ProductKey, UserID: claims.Subject, Team: claims.TeamID,
		Status: "pending", Reason: strings.TrimSpace(body.Reason),
	}
	if err := s.db.AddDataProductAccessRequest(r.Context(), rq); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_failed")
		return
	}
	s.auditAuthEvent(r.Context(), "data_product_access_request", claims.Subject, "", claims.TeamID, "product="+p.ProductKey)
	writeJSON(w, http.StatusCreated, map[string]any{"status": "requested", "product_key": p.ProductKey})
}
