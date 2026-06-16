package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// okfActor returns the caller identity for OKF audit/authorship.
func (s *Server) okfActor(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok && strings.TrimSpace(claims.Subject) != "" {
		return claims.Subject
	}
	return "admin"
}

type okfDocPayload struct {
	Kind       string          `json:"kind"`
	Subject    string          `json:"subject"`
	Title      string          `json:"title"`
	Body       string          `json:"body"`
	Attributes json.RawMessage `json:"attributes"`
	Tags       string          `json:"tags"`
	Source     string          `json:"source"`
	Status     string          `json:"status"`
}

func (p okfDocPayload) toDoc() store.OKFDocument {
	attrs := strings.TrimSpace(string(p.Attributes))
	if attrs == "" || attrs == "null" {
		attrs = "{}"
	}
	return store.OKFDocument{
		Kind: strings.TrimSpace(p.Kind), Subject: strings.TrimSpace(p.Subject),
		Title: p.Title, Body: p.Body, Attributes: attrs,
		Tags: strings.TrimSpace(p.Tags), Source: strings.TrimSpace(p.Source), Status: strings.TrimSpace(p.Status),
	}
}

// handleOKFDocuments serves GET (list, filtered) and POST (create/upsert) for OKF documents.
// GET  /admin/okf/documents?kind=&subject=&tag=&status=&limit=
// POST /admin/okf/documents {kind,subject,title,body,attributes,tags,source,status}
func (s *Server) handleOKFDocuments(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		docs, err := s.db.ListOKFDocuments(r.Context(), store.OKFFilter{
			Kind:    strings.TrimSpace(r.URL.Query().Get("kind")),
			Subject: strings.TrimSpace(r.URL.Query().Get("subject")),
			Tag:     strings.TrimSpace(r.URL.Query().Get("tag")),
			Status:  strings.TrimSpace(r.URL.Query().Get("status")),
			Limit:   recentLimit(r),
		})
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"documents": docs})
	case http.MethodPost:
		var p okfDocPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		doc := p.toDoc()
		if doc.Kind == "" || doc.Subject == "" {
			writeOpenAIError(w, http.StatusBadRequest, "kind and subject are required", "invalid_request_error", "missing_fields")
			return
		}
		if !json.Valid([]byte(doc.Attributes)) {
			writeOpenAIError(w, http.StatusBadRequest, "attributes must be valid JSON", "invalid_request_error", "invalid_attributes")
			return
		}
		saved, err := s.db.UpsertOKFDocument(r.Context(), doc, s.okfActor(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_save_failed")
			return
		}
		s.auditAdmin(r, "okf.document.upsert", saved.ID, auditJSON(map[string]any{"kind": saved.Kind, "subject": saved.Subject}))
		writeJSON(w, http.StatusCreated, map[string]any{"document": saved})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleOKFDocumentByID serves GET/DELETE for one OKF document.
// GET|DELETE /admin/okf/documents/by-id/{id}
func (s *Server) handleOKFDocumentByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/okf/documents/by-id/"), "/")
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "document id required", "invalid_request_error", "missing_id")
		return
	}
	switch r.Method {
	case http.MethodGet:
		doc, found, err := s.db.GetOKFDocument(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_get_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "document not found", "invalid_request_error", "not_found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"document": doc})
	case http.MethodDelete:
		if err := s.db.DeleteOKFDocument(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_delete_failed")
			return
		}
		s.auditAdmin(r, "okf.document.delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleOKFLinks serves GET (list, filtered) and POST (upsert) for knowledge-graph edges.
// GET  /admin/okf/links?from=&to=&relation=&limit=
// POST /admin/okf/links {from_subject,relation,to_subject,attributes,source}
func (s *Server) handleOKFLinks(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		links, err := s.db.ListOKFLinks(r.Context(),
			strings.TrimSpace(r.URL.Query().Get("from")),
			strings.TrimSpace(r.URL.Query().Get("to")),
			strings.TrimSpace(r.URL.Query().Get("relation")),
			recentLimit(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_links_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"links": links})
	case http.MethodPost:
		var p struct {
			FromSubject string          `json:"from_subject"`
			Relation    string          `json:"relation"`
			ToSubject   string          `json:"to_subject"`
			Attributes  json.RawMessage `json:"attributes"`
			Source      string          `json:"source"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		l := store.OKFLink{
			FromSubject: strings.TrimSpace(p.FromSubject), Relation: strings.TrimSpace(p.Relation),
			ToSubject: strings.TrimSpace(p.ToSubject), Attributes: strings.TrimSpace(string(p.Attributes)), Source: strings.TrimSpace(p.Source),
		}
		if l.FromSubject == "" || l.Relation == "" || l.ToSubject == "" {
			writeOpenAIError(w, http.StatusBadRequest, "from_subject, relation, to_subject are required", "invalid_request_error", "missing_fields")
			return
		}
		saved, err := s.db.UpsertOKFLink(r.Context(), l)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_link_save_failed")
			return
		}
		s.auditAdmin(r, "okf.link.upsert", saved.ID, auditJSON(map[string]any{"from": saved.FromSubject, "relation": saved.Relation, "to": saved.ToSubject}))
		writeJSON(w, http.StatusCreated, map[string]any{"link": saved})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// okfBundle is the portable export/import envelope.
type okfBundle struct {
	OKFVersion string              `json:"okf_version"`
	ExportedAt string              `json:"exported_at,omitempty"`
	Filter     map[string]string   `json:"filter,omitempty"`
	Documents  []store.OKFDocument `json:"documents"`
	Links      []store.OKFLink     `json:"links"`
}

// handleOKFExport returns a portable OKF bundle for the matching documents plus the links
// that touch their subjects.
// GET /admin/okf/export?kind=&subject=&tag=&status=
func (s *Server) handleOKFExport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	f := store.OKFFilter{
		Kind:    strings.TrimSpace(r.URL.Query().Get("kind")),
		Subject: strings.TrimSpace(r.URL.Query().Get("subject")),
		Tag:     strings.TrimSpace(r.URL.Query().Get("tag")),
		Status:  strings.TrimSpace(r.URL.Query().Get("status")),
		Limit:   5000,
	}
	docs, err := s.db.ListOKFDocuments(r.Context(), f)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_export_failed")
		return
	}
	allLinks, err := s.db.ListOKFLinks(r.Context(), "", "", "", 5000)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "okf_export_failed")
		return
	}
	filtered := f.Kind != "" || f.Subject != "" || f.Tag != "" || f.Status != ""
	subjects := map[string]bool{}
	for _, d := range docs {
		subjects[d.Subject] = true
	}
	links := []store.OKFLink{}
	for _, l := range allLinks {
		if !filtered || subjects[l.FromSubject] || subjects[l.ToSubject] {
			links = append(links, l)
		}
	}
	bundle := okfBundle{
		OKFVersion: "1.0",
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Filter:     map[string]string{"kind": f.Kind, "subject": f.Subject, "tag": f.Tag, "status": f.Status},
		Documents:  docs,
		Links:      links,
	}
	s.auditAdmin(r, "okf.export", "", auditJSON(map[string]any{"documents": len(docs), "links": len(links)}))
	writeJSON(w, http.StatusOK, bundle)
}

// handleOKFImport ingests an OKF bundle (documents + links), upserting each. Documents are
// keyed by (kind, subject) and links by (from, relation, to), so re-import is idempotent.
// POST /admin/okf/import {documents:[...],links:[...]}
func (s *Server) handleOKFImport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var bundle okfBundle
	if err := json.NewDecoder(r.Body).Decode(&bundle); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid OKF bundle JSON", "invalid_request_error", "invalid_body")
		return
	}
	actor := s.okfActor(r)
	docCount, linkCount := 0, 0
	errs := map[string]string{}
	for _, d := range bundle.Documents {
		if strings.TrimSpace(d.Kind) == "" || strings.TrimSpace(d.Subject) == "" {
			continue
		}
		if strings.TrimSpace(d.Attributes) == "" {
			d.Attributes = "{}"
		}
		if !json.Valid([]byte(d.Attributes)) {
			errs[d.Kind+":"+d.Subject] = "invalid attributes JSON"
			continue
		}
		if strings.TrimSpace(d.Source) == "" {
			d.Source = "import"
		}
		if _, err := s.db.UpsertOKFDocument(r.Context(), d, actor); err != nil {
			errs[d.Kind+":"+d.Subject] = err.Error()
			continue
		}
		docCount++
	}
	for _, l := range bundle.Links {
		if strings.TrimSpace(l.FromSubject) == "" || strings.TrimSpace(l.Relation) == "" || strings.TrimSpace(l.ToSubject) == "" {
			continue
		}
		if strings.TrimSpace(l.Source) == "" {
			l.Source = "import"
		}
		if _, err := s.db.UpsertOKFLink(r.Context(), l); err != nil {
			errs[l.FromSubject+"->"+l.ToSubject] = err.Error()
			continue
		}
		linkCount++
	}
	s.auditAdmin(r, "okf.import", "", auditJSON(map[string]any{"documents": docCount, "links": linkCount, "errors": len(errs)}))
	writeJSON(w, http.StatusOK, map[string]any{"imported_documents": docCount, "imported_links": linkCount, "errors": errs})
}
