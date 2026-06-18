package store

import (
	"context"
	"time"
)

func (s *SQLStore) InsertMCPRouteDecision(ctx context.Context, d MCPRouteDecision) error {
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`
		INSERT INTO mcp_route_decisions (
			id, request_id, trace_id, api_key_id, method, exposed_name,
			upstream_id, upstream_name, target_name, server_policy,
			tool_risk_level, tool_risk_action, final_decision, reason,
			latency_ms, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		d.ID, d.RequestID, d.TraceID, d.APIKeyID, d.Method, d.ExposedName,
		d.UpstreamID, d.UpstreamName, d.TargetName, d.ServerPolicy,
		d.ToolRiskLevel, d.ToolRiskAction, d.FinalDecision, d.Reason,
		d.LatencyMS, d.CreatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) MCPRouteDecisionsForRequest(ctx context.Context, requestID string) ([]MCPRouteDecision, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, COALESCE(trace_id, ''), COALESCE(api_key_id, ''),
			method, COALESCE(exposed_name, ''), COALESCE(upstream_id, ''),
			COALESCE(upstream_name, ''), COALESCE(target_name, ''),
			COALESCE(server_policy, ''), COALESCE(tool_risk_level, ''),
			COALESCE(tool_risk_action, ''), final_decision, COALESCE(reason, ''),
			latency_ms, created_at
		FROM mcp_route_decisions
		WHERE request_id = ?
		ORDER BY created_at ASC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPRouteDecision{}
	for rows.Next() {
		var d MCPRouteDecision
		var created string
		if err := rows.Scan(&d.ID, &d.RequestID, &d.TraceID, &d.APIKeyID, &d.Method, &d.ExposedName,
			&d.UpstreamID, &d.UpstreamName, &d.TargetName, &d.ServerPolicy,
			&d.ToolRiskLevel, &d.ToolRiskAction, &d.FinalDecision, &d.Reason,
			&d.LatencyMS, &created); err != nil {
			return nil, err
		}
		if ts, err := time.Parse(time.RFC3339Nano, created); err == nil {
			d.CreatedAt = ts
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *SQLStore) InsertMCPDiscoveryRun(ctx context.Context, d MCPDiscoveryRun) error {
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`
		INSERT INTO mcp_discovery_runs (
			id, upstream_id, upstream_name, status, tool_count,
			prompt_count, resource_count, error, latency_ms, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		d.ID, d.UpstreamID, d.UpstreamName, d.Status, d.ToolCount,
		d.PromptCount, d.ResourceCount, d.Error, d.LatencyMS,
		d.CreatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) MCPDiscoveryRuns(ctx context.Context, upstreamID string, limit int) ([]MCPDiscoveryRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, upstream_id, COALESCE(upstream_name, ''), status,
			tool_count, prompt_count, resource_count, COALESCE(error, ''),
			latency_ms, created_at
		FROM mcp_discovery_runs
		WHERE upstream_id = ?
		ORDER BY created_at DESC
		LIMIT ?`), upstreamID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPDiscoveryRun{}
	for rows.Next() {
		var d MCPDiscoveryRun
		var created string
		if err := rows.Scan(&d.ID, &d.UpstreamID, &d.UpstreamName, &d.Status,
			&d.ToolCount, &d.PromptCount, &d.ResourceCount, &d.Error,
			&d.LatencyMS, &created); err != nil {
			return nil, err
		}
		if ts, err := time.Parse(time.RFC3339Nano, created); err == nil {
			d.CreatedAt = ts
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
