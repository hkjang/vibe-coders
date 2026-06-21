package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PolicyRegressionCase is a named, fixed-input governance scenario with an expected outcome.
// It lets admins lock in policy behavior and detect when a policy change unexpectedly flips a
// decision. Inputs are explicit attributes (no raw prompt/SQL/tool args are stored).
type PolicyRegressionCase struct {
	ID                 string
	Name               string
	Description        string
	Model              string
	Provider           string
	TeamID             string
	Role               string
	Endpoint           string
	ComplexityScore    int
	RiskScore          int
	ContainsSecret     bool
	SecretTypes        []string
	MCPServer          string
	MCPTool            string
	Expect             string // allow | block | require_approval
	ExpectSecretAction string // "" (any) | detect | mask | block
	Enabled            bool
	CreatedBy          string
	CreatedAt          string
	UpdatedAt          string
}

// UpsertPolicyRegressionCase inserts or updates a regression case by id.
func (s *SQLStore) UpsertPolicyRegressionCase(ctx context.Context, c PolicyRegressionCase) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if strings.TrimSpace(c.CreatedAt) == "" {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	contains := 0
	if c.ContainsSecret {
		contains = 1
	}
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO policy_regression_cases
		(id, name, description, model, provider, team_id, role, endpoint, complexity_score, risk_score,
		 contains_secret, secret_types, mcp_server, mcp_tool, expect, expect_secret_action, enabled, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, description=excluded.description, model=excluded.model, provider=excluded.provider,
			team_id=excluded.team_id, role=excluded.role, endpoint=excluded.endpoint,
			complexity_score=excluded.complexity_score, risk_score=excluded.risk_score,
			contains_secret=excluded.contains_secret, secret_types=excluded.secret_types,
			mcp_server=excluded.mcp_server, mcp_tool=excluded.mcp_tool, expect=excluded.expect,
			expect_secret_action=excluded.expect_secret_action, enabled=excluded.enabled, updated_at=excluded.updated_at`),
		c.ID, c.Name, c.Description, c.Model, c.Provider, c.TeamID, c.Role, c.Endpoint, c.ComplexityScore, c.RiskScore,
		contains, strings.Join(c.SecretTypes, ","), c.MCPServer, c.MCPTool, c.Expect, c.ExpectSecretAction, enabled, c.CreatedBy, c.CreatedAt, c.UpdatedAt)
	return err
}

// ListPolicyRegressionCases returns all cases (optionally only enabled ones), newest first.
func (s *SQLStore) ListPolicyRegressionCases(ctx context.Context, onlyEnabled bool) ([]PolicyRegressionCase, error) {
	q := `SELECT id, name, description, model, provider, team_id, role, endpoint, complexity_score, risk_score,
		contains_secret, secret_types, mcp_server, mcp_tool, expect, expect_secret_action, enabled, created_by, created_at, updated_at
		FROM policy_regression_cases`
	if onlyEnabled {
		q += ` WHERE enabled = 1`
	}
	q += ` ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PolicyRegressionCase{}
	for rows.Next() {
		c, err := scanPolicyRegressionCase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetPolicyRegressionCase returns one case by id.
func (s *SQLStore) GetPolicyRegressionCase(ctx context.Context, id string) (PolicyRegressionCase, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, description, model, provider, team_id, role, endpoint, complexity_score, risk_score,
		contains_secret, secret_types, mcp_server, mcp_tool, expect, expect_secret_action, enabled, created_by, created_at, updated_at
		FROM policy_regression_cases WHERE id = ?`), id)
	c, err := scanPolicyRegressionCase(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PolicyRegressionCase{}, false, nil
	}
	if err != nil {
		return PolicyRegressionCase{}, false, err
	}
	return c, true, nil
}

// DeletePolicyRegressionCase removes a case by id.
func (s *SQLStore) DeletePolicyRegressionCase(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM policy_regression_cases WHERE id = ?`), id)
	return err
}

func scanPolicyRegressionCase(sc interface{ Scan(...any) error }) (PolicyRegressionCase, error) {
	var c PolicyRegressionCase
	var secretTypes string
	var contains, enabled int
	if err := sc.Scan(&c.ID, &c.Name, &c.Description, &c.Model, &c.Provider, &c.TeamID, &c.Role, &c.Endpoint,
		&c.ComplexityScore, &c.RiskScore, &contains, &secretTypes, &c.MCPServer, &c.MCPTool, &c.Expect,
		&c.ExpectSecretAction, &enabled, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return PolicyRegressionCase{}, err
	}
	c.ContainsSecret = contains != 0
	c.Enabled = enabled != 0
	if strings.TrimSpace(secretTypes) != "" {
		for _, t := range strings.Split(secretTypes, ",") {
			if t = strings.TrimSpace(t); t != "" {
				c.SecretTypes = append(c.SecretTypes, t)
			}
		}
	}
	return c, nil
}
