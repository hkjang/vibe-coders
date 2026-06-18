package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// okfSubjectTable extracts the table name from an OKF subject like "table:orders" or
// "column:orders.amount" (returns "" when the subject isn't table-scoped).
func okfSubjectTable(subject string) string {
	s := subject
	if i := strings.IndexByte(s, ':'); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.IndexByte(s, '.'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// okfText2SQLKnowledge renders the active OKF meta-knowledge relevant to a Text2SQL request
// (table notes scoped to the allowed tables, plus join paths, forbidden-query patterns,
// sample SQL, and general notes) into a compact, bounded prompt block. Empty when no OKF
// documents exist, so injection is a safe no-op until knowledge is curated.
func (s *Server) okfText2SQLKnowledge(ctx context.Context, allowed []string) string {
	allowSet := map[string]bool{}
	for _, t := range allowed {
		allowSet[strings.ToLower(t)] = true
	}
	var b strings.Builder
	add := func(kind, header string, scoped bool, max int) {
		docs, err := s.db.ListOKFDocuments(ctx, store.OKFFilter{Kind: kind, Status: "active", Limit: 300})
		if err != nil || len(docs) == 0 {
			return
		}
		lines := []string{}
		for _, d := range docs {
			body := strings.TrimSpace(d.Body)
			if body == "" {
				continue
			}
			if scoped && len(allowSet) > 0 {
				if tbl := okfSubjectTable(d.Subject); tbl != "" && !allowSet[strings.ToLower(tbl)] {
					continue
				}
			}
			title := d.Title
			if title == "" {
				title = d.Subject
			}
			lines = append(lines, "- "+title+": "+body)
			if len(lines) >= max {
				break
			}
		}
		if len(lines) > 0 {
			b.WriteString(header + "\n" + strings.Join(lines, "\n") + "\n\n")
		}
	}
	add("table", "테이블 설명:", true, 40)
	add("join_path", "조인 경로:", false, 30)
	add("forbidden_query", "금지/주의 쿼리 패턴:", false, 30)
	add("sample_sql", "샘플 SQL:", false, 8)
	add("note", "추가 지침:", false, 20)
	return strings.TrimSpace(b.String())
}

// handleOKFText2SQLSync seeds OKF documents from the Text2SQL schema registry (table and
// column descriptions) and golden queries (sample SQL), so the meta-knowledge base is
// pre-populated from what the gateway already knows. Idempotent (re-runnable).
// POST /admin/okf/text2sql/sync?schema=
func (s *Server) handleOKFText2SQLSync(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	schema := strings.TrimSpace(r.URL.Query().Get("schema"))
	if schema == "" {
		schema = "public"
	}
	actor := s.okfActor(r)
	tables, _ := s.db.ListText2SQLTables(r.Context(), schema)
	cols, _ := s.db.ListText2SQLColumns(r.Context(), schema)
	tableDocs, colDocs, sampleDocs := 0, 0, 0
	for _, t := range tables {
		if !t.Enabled || strings.TrimSpace(t.Description) == "" {
			continue
		}
		if _, err := s.db.UpsertOKFDocument(r.Context(), store.OKFDocument{
			Kind: "table", Subject: "table:" + t.TableName, Title: t.TableName,
			Body: t.Description, Tags: schema, Source: "derived:schema",
		}, actor); err == nil {
			tableDocs++
		}
	}
	for _, c := range cols {
		if strings.TrimSpace(c.Description) == "" {
			continue
		}
		body := c.Description
		if c.DataType != "" {
			body += " (" + c.DataType + ")"
		}
		if c.Sensitivity != "" && c.Sensitivity != "normal" {
			body += " [민감도: " + c.Sensitivity + "]"
		}
		if _, err := s.db.UpsertOKFDocument(r.Context(), store.OKFDocument{
			Kind: "column", Subject: "column:" + c.TableName + "." + c.ColumnName, Title: c.TableName + "." + c.ColumnName,
			Body: body, Tags: schema, Source: "derived:schema",
		}, actor); err == nil {
			colDocs++
		}
	}
	if goldens, err := s.db.ListText2SQLGoldenQueries(r.Context(), true); err == nil {
		for _, g := range goldens {
			if strings.TrimSpace(g.ExpectedSQL) == "" {
				continue
			}
			if _, err := s.db.UpsertOKFDocument(r.Context(), store.OKFDocument{
				Kind: "sample_sql", Subject: "sample_sql:" + g.ID, Title: g.Question,
				Body: g.ExpectedSQL, Tags: schema, Source: "derived:golden",
			}, actor); err == nil {
				sampleDocs++
			}
		}
	}
	s.auditAdmin(r, "okf.text2sql.sync", schema, auditJSON(map[string]any{"tables": tableDocs, "columns": colDocs, "samples": sampleDocs}))
	writeJSON(w, http.StatusOK, map[string]any{"schema": schema, "table_docs": tableDocs, "column_docs": colDocs, "sample_docs": sampleDocs})
}

// okfSlug makes a short, stable, human-readable subject suffix from free text.
func okfSlug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '\t' || r == '-' || r == '_':
			b.WriteByte('-')
		}
		if b.Len() >= 60 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "item"
	}
	return out
}

// handleOKFGraphSync derives the gateway knowledge graph from existing entities: API keys
// linked to their owner/team, and models linked to the upstream that serves them. These
// edges make "왜 이 요청이 이 모델/업스트림으로 갔는지" explainable from OKF links.
// POST /admin/okf/graph/sync
func (s *Server) handleOKFGraphSync(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	ctx := r.Context()
	actor := s.okfActor(r)
	docs, links := 0, 0

	if keys, err := s.db.ListAPIKeys(ctx); err == nil {
		for _, k := range keys {
			if _, err := s.db.UpsertOKFDocument(ctx, store.OKFDocument{
				Kind: "entity", Subject: "api_key:" + k.ID, Title: firstNonEmpty(k.Name, k.ID),
				Body: "role=" + k.Role + (map[bool]string{true: ", status=" + k.Status, false: ""})[k.Status != ""],
				Source: "derived:graph", Status: "active",
			}, actor); err == nil {
				docs++
			}
			if strings.TrimSpace(k.UserID) != "" {
				if _, err := s.db.UpsertOKFLink(ctx, store.OKFLink{FromSubject: "api_key:" + k.ID, Relation: "owned_by", ToSubject: "user:" + k.UserID, Source: "derived:graph"}); err == nil {
					links++
				}
			}
			if strings.TrimSpace(k.Team) != "" {
				if _, err := s.db.UpsertOKFLink(ctx, store.OKFLink{FromSubject: "api_key:" + k.ID, Relation: "in_team", ToSubject: "team:" + k.Team, Source: "derived:graph"}); err == nil {
					links++
				}
			}
		}
	}

	if provs, err := s.db.ListProviderConfigs(ctx); err == nil {
		for _, p := range provs {
			if _, err := s.db.UpsertOKFDocument(ctx, store.OKFDocument{
				Kind: "entity", Subject: "upstream:" + p.Name, Title: p.Name, Body: p.BaseURL,
				Source: "derived:graph", Status: "active",
			}, actor); err == nil {
				docs++
			}
			for _, pat := range strings.Split(p.ModelPatterns, ",") {
				pat = strings.TrimSpace(pat)
				if pat == "" {
					continue
				}
				if _, err := s.db.UpsertOKFLink(ctx, store.OKFLink{FromSubject: "model:" + pat, Relation: "served_by", ToSubject: "upstream:" + p.Name, Source: "derived:graph"}); err == nil {
					links++
				}
			}
		}
	}

	s.auditAdmin(r, "okf.graph.sync", "", auditJSON(map[string]any{"entity_docs": docs, "links": links}))
	writeJSON(w, http.StatusOK, map[string]any{"entity_docs": docs, "links": links})
}

// handleOKFPropose is the agent self-improvement loop: it mines recurring Text2SQL questions
// (report candidates) into PROPOSED OKF sample_sql documents for human review. Approving a
// proposal = re-saving it with status "active" (POST /admin/okf/documents). Nothing is added
// to the active knowledge base automatically.
// POST /admin/okf/propose?window=30d&min_count=3
func (s *Server) handleOKFPropose(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := intQuery(r, "min_count", 3)
	cands, err := s.db.Text2SQLReportCandidates(r.Context(), since, minCount, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "propose_failed")
		return
	}
	actor := s.okfActor(r)
	proposed := []map[string]any{}
	for _, c := range cands {
		if strings.TrimSpace(c.SampleSQL) == "" {
			continue
		}
		attrs := auditJSON(map[string]any{"count": c.Count, "recommended_product": c.RecommendedProduct, "origin": "report_candidate"})
		doc, err := s.db.UpsertOKFDocument(r.Context(), store.OKFDocument{
			Kind: "sample_sql", Subject: "sample_sql:proposed:" + okfSlug(c.Question), Title: c.Question,
			Body: c.SampleSQL, Attributes: attrs, Source: "proposed:miner", Status: "proposed",
		}, actor)
		if err == nil {
			proposed = append(proposed, map[string]any{"id": doc.ID, "subject": doc.Subject, "count": c.Count})
		}
	}
	s.auditAdmin(r, "okf.propose", "", auditJSON(map[string]any{"proposed": len(proposed)}))
	writeJSON(w, http.StatusOK, map[string]any{"proposed": len(proposed), "documents": proposed, "note": "status=proposed; review and re-save with status=active to approve"})
}

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
