package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// MCPToolContract is the governed declaration of an MCP tool: its namespace/name, the input and
// output JSON schemas it promises, a risk level, an execution timeout, the roles allowed to call
// it, a cost policy note, and an owner. The registry lets admins pin a contract and later detect
// drift between it and the tool actually advertised by the gateway. Schemas are declarations only
// (no raw prompts/args ever stored here).
type MCPToolContract struct {
	ID           string `json:"id"`
	Namespace    string `json:"namespace"` // e.g. "gateway"
	Name         string `json:"name"`      // tool name, e.g. "gateway_chat"
	Title        string `json:"title"`
	Description  string `json:"description"`
	InputSchema  string `json:"input_schema"`  // JSON schema text
	OutputSchema string `json:"output_schema"` // JSON schema text
	RiskLevel    string `json:"risk_level"`    // low | medium | high
	TimeoutMS    int64  `json:"timeout_ms"`
	AllowedRoles string `json:"allowed_roles"` // CSV
	CostPolicy   string `json:"cost_policy"`
	Owner        string `json:"owner"`
	Enabled      bool   `json:"enabled"`
	CreatedBy    string `json:"created_by"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

const mcpToolContractColumns = `id, namespace, name, title, description, input_schema, output_schema, risk_level, timeout_ms, allowed_roles, cost_policy, owner, enabled, created_by, created_at, updated_at`

func (s *SQLStore) UpsertMCPToolContract(ctx context.Context, c MCPToolContract) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if c.CreatedAt == "" {
		c.CreatedAt = now
	}
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO mcp_tool_contracts
		(id, namespace, name, title, description, input_schema, output_schema, risk_level, timeout_ms, allowed_roles, cost_policy, owner, enabled, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			namespace=excluded.namespace, name=excluded.name, title=excluded.title, description=excluded.description,
			input_schema=excluded.input_schema, output_schema=excluded.output_schema, risk_level=excluded.risk_level,
			timeout_ms=excluded.timeout_ms, allowed_roles=excluded.allowed_roles, cost_policy=excluded.cost_policy,
			owner=excluded.owner, enabled=excluded.enabled, updated_at=excluded.updated_at`),
		c.ID, c.Namespace, c.Name, c.Title, c.Description, c.InputSchema, c.OutputSchema, c.RiskLevel,
		c.TimeoutMS, c.AllowedRoles, c.CostPolicy, c.Owner, enabled, c.CreatedBy, c.CreatedAt, now)
	return err
}

func scanMCPToolContract(sc interface{ Scan(...any) error }) (MCPToolContract, error) {
	var c MCPToolContract
	var enabled int
	if err := sc.Scan(&c.ID, &c.Namespace, &c.Name, &c.Title, &c.Description, &c.InputSchema, &c.OutputSchema,
		&c.RiskLevel, &c.TimeoutMS, &c.AllowedRoles, &c.CostPolicy, &c.Owner, &enabled, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return MCPToolContract{}, err
	}
	c.Enabled = enabled != 0
	return c, nil
}

func (s *SQLStore) ListMCPToolContracts(ctx context.Context, namespace string, onlyEnabled bool) ([]MCPToolContract, error) {
	q := `SELECT ` + mcpToolContractColumns + ` FROM mcp_tool_contracts`
	conds := []string{}
	args := []any{}
	if namespace != "" {
		conds = append(conds, `namespace = ?`)
		args = append(args, namespace)
	}
	if onlyEnabled {
		conds = append(conds, `enabled = 1`)
	}
	for i, c := range conds {
		if i == 0 {
			q += ` WHERE ` + c
		} else {
			q += ` AND ` + c
		}
	}
	q += ` ORDER BY namespace ASC, name ASC`
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPToolContract{}
	for rows.Next() {
		c, err := scanMCPToolContract(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetMCPToolContract(ctx context.Context, id string) (MCPToolContract, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT `+mcpToolContractColumns+` FROM mcp_tool_contracts WHERE id = ?`), id)
	c, err := scanMCPToolContract(row)
	if errors.Is(err, sql.ErrNoRows) {
		return MCPToolContract{}, false, nil
	}
	if err != nil {
		return MCPToolContract{}, false, err
	}
	return c, true, nil
}

func (s *SQLStore) DeleteMCPToolContract(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM mcp_tool_contracts WHERE id = ?`), id)
	return err
}
