package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// AgentRoute binds a client-callable VIRTUAL model name to a concrete backing LLM plus a fixed set
// of MCP upstreams. Calling the virtual model runs an agentic loop (LLM ↔ those MCP tools) scoped to
// exactly the configured providers/servers — the operator-defined counterpart to the built-in
// auto-discovery models (vibe/grounded, vibe/all-mcp, …).
type AgentRoute struct {
	ID           string   `json:"id"`
	VirtualModel string   `json:"virtual_model"`
	Name         string   `json:"name"`
	Enabled      bool     `json:"enabled"`
	BackingModel string   `json:"backing_model"` // concrete model the loop calls; "" → auto-select
	Provider     string   `json:"provider"`      // pin the backing LLM to this provider; "" → normal routing
	ProviderRef  string   `json:"provider_ref,omitempty"`
	MCPUpstreams []string `json:"mcp_upstreams"` // MCP upstream IDs exposed as tools; empty → all registered
	AllowedTools []string `json:"allowed_tools"` // namespaced or bare tool names to expose; empty → all tools of the servers
	SystemPrompt string   `json:"system_prompt"`
	MaxSteps     int      `json:"max_steps"`
	MaxCostKRW   float64  `json:"max_cost_krw"` // per-call KRW budget for the agentic loop; 0 → unlimited
	CreatedBy    string   `json:"created_by"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

// AgentRouteModel is the non-sensitive projection used by the anonymous public
// model catalogue. AgentRoute contains prompts, tool allowlists, and ownership
// metadata that must not be materialized merely to advertise a virtual model.
type AgentRouteModel struct {
	ID           string
	VirtualModel string
}

const (
	maxBoundedAgentRouteModels          = 20_000
	maxBoundedAgentRouteModelFieldBytes = 512
)

// UpsertAgentRoute inserts or updates an agent route (keyed by id).
func (s *SQLStore) UpsertAgentRoute(ctx context.Context, a AgentRoute) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if a.CreatedAt == "" {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO agent_routes
		(id, virtual_model, name, enabled, backing_model, provider, mcp_upstreams_json, allowed_tools_json, system_prompt, max_steps, max_cost_krw, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			virtual_model=excluded.virtual_model, name=excluded.name, enabled=excluded.enabled,
			backing_model=excluded.backing_model, provider=excluded.provider,
			mcp_upstreams_json=excluded.mcp_upstreams_json, allowed_tools_json=excluded.allowed_tools_json,
			system_prompt=excluded.system_prompt, max_steps=excluded.max_steps, max_cost_krw=excluded.max_cost_krw,
			updated_at=excluded.updated_at`),
		a.ID, a.VirtualModel, a.Name, boolInt(a.Enabled), a.BackingModel, a.Provider,
		encodeStringList(a.MCPUpstreams), encodeStringList(a.AllowedTools), a.SystemPrompt, a.MaxSteps, a.MaxCostKRW, a.CreatedBy, a.CreatedAt, a.UpdatedAt)
	if err != nil {
		return err
	}
	s.agentRoutes.invalidate()
	return nil
}

// ListAgentRoutes returns all agent routes, newest first.
func (s *SQLStore) ListAgentRoutes(ctx context.Context) ([]AgentRoute, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, virtual_model, name, enabled, backing_model, provider,
		mcp_upstreams_json, allowed_tools_json, system_prompt, max_steps, max_cost_krw, created_by, created_at, updated_at
		FROM agent_routes ORDER BY created_at DESC`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentRoute{}
	for rows.Next() {
		a, err := scanAgentRoute(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListEnabledAgentRouteModelsBounded returns only the two fields required by the
// anonymous /v1/models response. LIMIT cap+1 detects truncation, while SUBSTR
// prevents a legacy oversized field from being scanned into application memory.
// The second boolean distinguishes row overflow from invalid projected fields so
// callers can conservatively handle route shadows that were not inspected.
func (s *SQLStore) ListEnabledAgentRouteModelsBounded(ctx context.Context, limit int) ([]AgentRouteModel, bool, bool, error) {
	if limit <= 0 {
		return []AgentRouteModel{}, false, false, nil
	}
	if limit > maxBoundedAgentRouteModels {
		limit = maxBoundedAgentRouteModels
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT
		SUBSTR(id, 1, ?), SUBSTR(virtual_model, 1, ?),
		CASE WHEN LENGTH(id) > ? OR LENGTH(virtual_model) > ? THEN 1 ELSE 0 END
		FROM agent_routes WHERE enabled = 1 ORDER BY created_at DESC, id ASC LIMIT ?`),
		maxBoundedAgentRouteModelFieldBytes+1, maxBoundedAgentRouteModelFieldBytes+1,
		maxBoundedAgentRouteModelFieldBytes, maxBoundedAgentRouteModelFieldBytes, limit+1)
	if err != nil {
		return nil, false, false, err
	}
	defer rows.Close()
	models := make([]AgentRouteModel, 0, limit)
	truncated := false
	overflow := false
	rowsSeen := 0
	for rows.Next() {
		rowsSeen++
		var model AgentRouteModel
		var oversized int
		if err := rows.Scan(&model.ID, &model.VirtualModel, &oversized); err != nil {
			return nil, false, false, err
		}
		if rowsSeen > limit {
			overflow = true
			truncated = true
			continue
		}
		if oversized != 0 || len(model.ID) > maxBoundedAgentRouteModelFieldBytes || len(model.VirtualModel) > maxBoundedAgentRouteModelFieldBytes || strings.TrimSpace(model.VirtualModel) != model.VirtualModel || model.VirtualModel == "" {
			truncated = true
			continue
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return nil, false, false, err
	}
	return models, truncated, overflow, nil
}

// GetAgentRoute fetches one route by id.
func (s *SQLStore) GetAgentRoute(ctx context.Context, id string) (AgentRoute, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, virtual_model, name, enabled, backing_model, provider,
		mcp_upstreams_json, allowed_tools_json, system_prompt, max_steps, max_cost_krw, created_by, created_at, updated_at
		FROM agent_routes WHERE id = ?`), id)
	a, err := scanAgentRoute(row)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentRoute{}, false, nil
	}
	if err != nil {
		return AgentRoute{}, false, err
	}
	return a, true, nil
}

// DeleteAgentRoute removes an agent route by id.
func (s *SQLStore) DeleteAgentRoute(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM agent_routes WHERE id = ?`), id); err != nil {
		return err
	}
	s.agentRoutes.invalidate()
	return nil
}

func scanAgentRoute(sc interface{ Scan(...any) error }) (AgentRoute, error) {
	var a AgentRoute
	var enabled int
	var mcpJSON, toolsJSON string
	if err := sc.Scan(&a.ID, &a.VirtualModel, &a.Name, &enabled, &a.BackingModel, &a.Provider,
		&mcpJSON, &toolsJSON, &a.SystemPrompt, &a.MaxSteps, &a.MaxCostKRW, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return AgentRoute{}, err
	}
	a.Enabled = enabled != 0
	a.MCPUpstreams = decodeStringList(mcpJSON)
	a.AllowedTools = decodeStringList(toolsJSON)
	return a, nil
}
