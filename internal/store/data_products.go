package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// DataProduct is a curated, published, team-scoped catalog entry that points at an existing
// building block (a saved Text2SQL report, a DW metric, or a golden query) by reference. It
// stores only metadata — never raw SQL/prompt — so teams can discover and request reusable data
// assets. The underlying source keeps its own (admin-only) definition.
type DataProduct struct {
	ID           string   `json:"id"`
	ProductKey   string   `json:"product_key"`
	NameKO       string   `json:"name_ko"`
	Description  string   `json:"description"`
	SourceType   string   `json:"source_type"` // saved_report | metric | golden_query | custom
	SourceRef    string   `json:"source_ref"`  // id/key of the source (no raw SQL stored)
	Owner        string   `json:"owner"`
	AllowedTeams []string `json:"allowed_teams"` // empty = all teams
	Sensitivity  string   `json:"sensitivity"`   // public | internal | restricted
	Status       string   `json:"status"`        // draft | published | archived
	Version      int      `json:"version"`
	UpdatedBy    string   `json:"updated_by"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

// DataProductAccessRequest is a team member's request to use a data product (mirrors the skill
// marketplace access-request model).
type DataProductAccessRequest struct {
	ID         string `json:"id"`
	ProductKey string `json:"product_key"`
	UserID     string `json:"user_id"`
	Team       string `json:"team"`
	Status     string `json:"status"` // pending | approved | denied
	Reason     string `json:"reason"`
	DecidedBy  string `json:"decided_by"`
	CreatedAt  string `json:"created_at"`
}

// UpsertDataProduct inserts or updates a data product by product_key, bumping version on update.
func (s *SQLStore) UpsertDataProduct(ctx context.Context, p DataProduct) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if p.Sensitivity == "" {
		p.Sensitivity = "internal"
	}
	if p.SourceType == "" {
		p.SourceType = "custom"
	}
	if p.Status == "" {
		p.Status = "draft"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO data_products
		(id, product_key, name_ko, description, source_type, source_ref, owner, allowed_teams, sensitivity, status, version, updated_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		ON CONFLICT(product_key) DO UPDATE SET
			name_ko = excluded.name_ko, description = excluded.description, source_type = excluded.source_type,
			source_ref = excluded.source_ref, owner = excluded.owner, allowed_teams = excluded.allowed_teams,
			sensitivity = excluded.sensitivity, status = excluded.status, version = data_products.version + 1,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
		p.ID, p.ProductKey, p.NameKO, p.Description, p.SourceType, p.SourceRef, p.Owner,
		strings.Join(p.AllowedTeams, ","), p.Sensitivity, p.Status, p.UpdatedBy, now, now)
	return err
}

func scanDataProduct(sc interface{ Scan(...any) error }) (DataProduct, error) {
	var p DataProduct
	var teams string
	if err := sc.Scan(&p.ID, &p.ProductKey, &p.NameKO, &p.Description, &p.SourceType, &p.SourceRef,
		&p.Owner, &teams, &p.Sensitivity, &p.Status, &p.Version, &p.UpdatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return DataProduct{}, err
	}
	for _, t := range strings.Split(teams, ",") {
		if t = strings.TrimSpace(t); t != "" {
			p.AllowedTeams = append(p.AllowedTeams, t)
		}
	}
	return p, nil
}

// ListDataProducts returns products, optionally filtered by status (empty = all), newest first.
func (s *SQLStore) ListDataProducts(ctx context.Context, status string) ([]DataProduct, error) {
	q := `SELECT id, product_key, name_ko, description, source_type, source_ref, owner, allowed_teams, sensitivity, status, version, updated_by, created_at, updated_at
		FROM data_products`
	args := []any{}
	if status != "" {
		q += ` WHERE status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DataProduct{}
	for rows.Next() {
		p, err := scanDataProduct(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetDataProduct returns a product by id or product_key.
func (s *SQLStore) GetDataProduct(ctx context.Context, idOrKey string) (DataProduct, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, product_key, name_ko, description, source_type, source_ref, owner, allowed_teams, sensitivity, status, version, updated_by, created_at, updated_at
		FROM data_products WHERE id = ? OR product_key = ?`), idOrKey, idOrKey)
	p, err := scanDataProduct(row)
	if errors.Is(err, sql.ErrNoRows) {
		return DataProduct{}, false, nil
	}
	if err != nil {
		return DataProduct{}, false, err
	}
	return p, true, nil
}

// DeleteDataProduct removes a product by id or product_key.
func (s *SQLStore) DeleteDataProduct(ctx context.Context, idOrKey string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM data_products WHERE id = ? OR product_key = ?`), idOrKey, idOrKey)
	return err
}

// AddDataProductAccessRequest records a member's access request (defaults to pending).
func (s *SQLStore) AddDataProductAccessRequest(ctx context.Context, rq DataProductAccessRequest) error {
	if rq.Status == "" {
		rq.Status = "pending"
	}
	rq.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO data_product_access_requests
		(id, product_key, user_id, team, status, reason, decided_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		rq.ID, rq.ProductKey, rq.UserID, rq.Team, rq.Status, rq.Reason, rq.DecidedBy, rq.CreatedAt)
	return err
}

// ListDataProductAccessRequests returns access requests, optionally filtered by product_key.
func (s *SQLStore) ListDataProductAccessRequests(ctx context.Context, productKey string) ([]DataProductAccessRequest, error) {
	q := `SELECT id, product_key, user_id, team, status, reason, decided_by, created_at FROM data_product_access_requests`
	args := []any{}
	if productKey != "" {
		q += ` WHERE product_key = ?`
		args = append(args, productKey)
	}
	q += ` ORDER BY created_at DESC LIMIT 200`
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DataProductAccessRequest{}
	for rows.Next() {
		var rq DataProductAccessRequest
		if err := rows.Scan(&rq.ID, &rq.ProductKey, &rq.UserID, &rq.Team, &rq.Status, &rq.Reason, &rq.DecidedBy, &rq.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rq)
	}
	return out, rows.Err()
}

// DecideDataProductAccessRequest approves or denies a request.
func (s *SQLStore) DecideDataProductAccessRequest(ctx context.Context, id string, approve bool, by string) error {
	status := "denied"
	if approve {
		status = "approved"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE data_product_access_requests SET status = ?, decided_by = ? WHERE id = ?`), status, by, id)
	return err
}
