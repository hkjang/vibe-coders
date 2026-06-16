package store

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// OKFDocument is one portable knowledge unit (Open Knowledge Format): a typed document
// about a subject, with free-text body and a JSON attributes blob. Documents are linked to
// each other via OKFLink. Used for Text2SQL meta-knowledge (table/column descriptions, join
// paths, forbidden queries, sample SQL) and gateway knowledge-graph entities.
type OKFDocument struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`    // schema|table|column|join_path|forbidden_query|sample_sql|model_policy|entity|glossary|note
	Subject    string `json:"subject"` // stable key the doc is about, e.g. "table:orders", "model:gpt-4.1"
	Title      string `json:"title"`
	Body       string `json:"body"`
	Attributes string `json:"attributes"` // JSON object (structured fields)
	Tags       string `json:"tags"`       // comma-separated (e.g. project/domain)
	Source     string `json:"source"`     // manual|derived:schema|proposed:miner|import
	Status     string `json:"status"`     // active|proposed|archived
	Version    int    `json:"version"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
	UpdatedBy  string `json:"updated_by"`
}

// OKFLink is a directed relationship between two subjects (knowledge-graph edge), e.g.
// "table:orders" --joins--> "table:customers", or "api_key:k1" --routed_to--> "model:gpt-4.1".
type OKFLink struct {
	ID          string `json:"id"`
	FromSubject string `json:"from_subject"`
	Relation    string `json:"relation"`
	ToSubject   string `json:"to_subject"`
	Attributes  string `json:"attributes"`
	Source      string `json:"source"`
	CreatedAt   string `json:"created_at"`
}

// OKFFilter narrows document listing/export.
type OKFFilter struct {
	Kind    string
	Subject string
	Tag     string
	Status  string
	Limit   int
}

func okfHashID(prefix string, parts ...string) string {
	h := sha1.New()
	for i, p := range parts {
		if i > 0 {
			h.Write([]byte{0})
		}
		h.Write([]byte(p))
	}
	return prefix + "_" + hex.EncodeToString(h.Sum(nil))[:20]
}

// OKFDocID is the deterministic id for a (kind, subject) pair, so re-seeding the same
// subject updates the existing row instead of creating duplicates.
func OKFDocID(kind, subject string) string { return okfHashID("okfd", kind, subject) }

// OKFLinkID is the deterministic id for a (from, relation, to) edge.
func OKFLinkID(from, relation, to string) string { return okfHashID("okfl", from, relation, to) }

func normalizeOKFDoc(d *OKFDocument) {
	if strings.TrimSpace(d.Attributes) == "" {
		d.Attributes = "{}"
	}
	if strings.TrimSpace(d.Status) == "" {
		d.Status = "active"
	}
	if strings.TrimSpace(d.Source) == "" {
		d.Source = "manual"
	}
}

// UpsertOKFDocument inserts or updates a document keyed by (kind, subject); the version is
// bumped on update. Returns the stored document.
func (s *SQLStore) UpsertOKFDocument(ctx context.Context, d OKFDocument, updatedBy string) (OKFDocument, error) {
	normalizeOKFDoc(&d)
	d.ID = OKFDocID(d.Kind, d.Subject)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	d.UpdatedAt = now
	d.UpdatedBy = updatedBy

	var oldVersion int
	var createdAt string
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT version, created_at FROM okf_documents WHERE id = ?`), d.ID)
	switch err := row.Scan(&oldVersion, &createdAt); {
	case errors.Is(err, sql.ErrNoRows):
		d.Version = 1
		d.CreatedAt = now
	case err != nil:
		return OKFDocument{}, err
	default:
		d.Version = oldVersion + 1
		d.CreatedAt = createdAt
	}

	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO okf_documents
		(id, kind, subject, title, body, attributes, tags, source, status, version, created_at, updated_at, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title, body = excluded.body, attributes = excluded.attributes,
			tags = excluded.tags, source = excluded.source, status = excluded.status,
			version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
		d.ID, d.Kind, d.Subject, d.Title, d.Body, d.Attributes, d.Tags, d.Source, d.Status, d.Version, d.CreatedAt, d.UpdatedAt, d.UpdatedBy); err != nil {
		return OKFDocument{}, err
	}
	return d, nil
}

// GetOKFDocument returns one document by id.
func (s *SQLStore) GetOKFDocument(ctx context.Context, id string) (OKFDocument, bool, error) {
	var d OKFDocument
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, kind, subject, title, body, attributes, tags, source, status, version, created_at, updated_at, COALESCE(updated_by, '')
		FROM okf_documents WHERE id = ?`), id).
		Scan(&d.ID, &d.Kind, &d.Subject, &d.Title, &d.Body, &d.Attributes, &d.Tags, &d.Source, &d.Status, &d.Version, &d.CreatedAt, &d.UpdatedAt, &d.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return OKFDocument{}, false, nil
	}
	if err != nil {
		return OKFDocument{}, false, err
	}
	return d, true, nil
}

// ListOKFDocuments returns documents matching the filter (newest-updated first).
func (s *SQLStore) ListOKFDocuments(ctx context.Context, f OKFFilter) ([]OKFDocument, error) {
	limit := f.Limit
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	where := []string{}
	args := []any{}
	if f.Kind != "" {
		where = append(where, "kind = ?")
		args = append(args, f.Kind)
	}
	if f.Subject != "" {
		where = append(where, "subject = ?")
		args = append(args, f.Subject)
	}
	if f.Status != "" {
		where = append(where, "status = ?")
		args = append(args, f.Status)
	}
	if f.Tag != "" {
		where = append(where, "tags LIKE ?")
		args = append(args, "%"+f.Tag+"%")
	}
	q := `SELECT id, kind, subject, title, body, attributes, tags, source, status, version, created_at, updated_at, COALESCE(updated_by, '')
		FROM okf_documents`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY updated_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OKFDocument{}
	for rows.Next() {
		var d OKFDocument
		if err := rows.Scan(&d.ID, &d.Kind, &d.Subject, &d.Title, &d.Body, &d.Attributes, &d.Tags, &d.Source, &d.Status, &d.Version, &d.CreatedAt, &d.UpdatedAt, &d.UpdatedBy); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeleteOKFDocument removes a document by id.
func (s *SQLStore) DeleteOKFDocument(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM okf_documents WHERE id = ?`), id)
	return err
}

// UpsertOKFLink inserts or updates a relationship edge (keyed by from/relation/to).
func (s *SQLStore) UpsertOKFLink(ctx context.Context, l OKFLink) (OKFLink, error) {
	if strings.TrimSpace(l.Attributes) == "" {
		l.Attributes = "{}"
	}
	if strings.TrimSpace(l.Source) == "" {
		l.Source = "manual"
	}
	l.ID = OKFLinkID(l.FromSubject, l.Relation, l.ToSubject)
	if l.CreatedAt == "" {
		l.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO okf_links (id, from_subject, relation, to_subject, attributes, source, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET attributes = excluded.attributes, source = excluded.source`),
		l.ID, l.FromSubject, l.Relation, l.ToSubject, l.Attributes, l.Source, l.CreatedAt); err != nil {
		return OKFLink{}, err
	}
	return l, nil
}

// ListOKFLinks returns edges optionally filtered by endpoint/relation.
func (s *SQLStore) ListOKFLinks(ctx context.Context, fromSubject, toSubject, relation string, limit int) ([]OKFLink, error) {
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	where := []string{}
	args := []any{}
	if fromSubject != "" {
		where = append(where, "from_subject = ?")
		args = append(args, fromSubject)
	}
	if toSubject != "" {
		where = append(where, "to_subject = ?")
		args = append(args, toSubject)
	}
	if relation != "" {
		where = append(where, "relation = ?")
		args = append(args, relation)
	}
	q := `SELECT id, from_subject, relation, to_subject, attributes, source, created_at FROM okf_links`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OKFLink{}
	for rows.Next() {
		var l OKFLink
		if err := rows.Scan(&l.ID, &l.FromSubject, &l.Relation, &l.ToSubject, &l.Attributes, &l.Source, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// DeleteOKFLink removes an edge by id.
func (s *SQLStore) DeleteOKFLink(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM okf_links WHERE id = ?`), id)
	return err
}
