package store

import (
	"context"
	"strings"
	"time"
)

// ToolFilter narrows MCP/tool aggregates to a scope.
type ToolFilter struct {
	APIKeyID    string
	ServerLabel string
	ToolName    string
	MCPOnly     bool
	Since       time.Time
	Limit       int
}

func (f ToolFilter) where() (string, []any) {
	clauses := []string{"1=1"}
	args := []any{}
	if f.APIKeyID != "" {
		clauses = append(clauses, "api_key_id = ?")
		args = append(args, f.APIKeyID)
	}
	if f.ServerLabel != "" {
		clauses = append(clauses, "COALESCE(NULLIF(server_label, ''), '(none)') = ?")
		args = append(args, f.ServerLabel)
	}
	if f.ToolName != "" {
		clauses = append(clauses, "tool_name = ?")
		args = append(args, f.ToolName)
	}
	if f.MCPOnly {
		clauses = append(clauses, "is_mcp = 1")
	}
	if !f.Since.IsZero() {
		clauses = append(clauses, "created_at >= ?")
		args = append(args, f.Since.UTC().Format(time.RFC3339Nano))
	}
	return strings.Join(clauses, " AND "), args
}

// whereAliased is where() with every tool_invocations column qualified by the given
// alias, so the clause is unambiguous when joined to request_logs.
func (f ToolFilter) whereAliased(a string) (string, []any) {
	p := a + "."
	clauses := []string{"1=1"}
	args := []any{}
	if f.APIKeyID != "" {
		clauses = append(clauses, p+"api_key_id = ?")
		args = append(args, f.APIKeyID)
	}
	if f.ServerLabel != "" {
		clauses = append(clauses, "COALESCE(NULLIF("+p+"server_label, ''), '(none)') = ?")
		args = append(args, f.ServerLabel)
	}
	if f.ToolName != "" {
		clauses = append(clauses, p+"tool_name = ?")
		args = append(args, f.ToolName)
	}
	if f.MCPOnly {
		clauses = append(clauses, p+"is_mcp = 1")
	}
	if !f.Since.IsZero() {
		clauses = append(clauses, p+"created_at >= ?")
		args = append(args, f.Since.UTC().Format(time.RFC3339Nano))
	}
	return strings.Join(clauses, " AND "), args
}

// ListMCPTools returns per-(server,tool) aggregates ordered by total activity.
func (s *SQLStore) ListMCPTools(ctx context.Context, f ToolFilter) ([]MCPToolStat, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	whereSQL, args := f.whereAliased("ti")
	args = append(args, limit)
	query := s.bind(`
		SELECT COALESCE(NULLIF(ti.server_label, ''), '(none)') AS server,
			ti.tool_name,
			MAX(ti.is_mcp) AS is_mcp,
			SUM(CASE WHEN ti.source = 'definition' THEN 1 ELSE 0 END) AS definitions,
			SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END) AS calls,
			SUM(CASE WHEN ti.source = 'result' THEN 1 ELSE 0 END) AS results,
			SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END) AS errors,
			COUNT(DISTINCT NULLIF(ti.api_key_id, '')) AS distinct_keys,
			COUNT(DISTINCT NULLIF(r.client_ip, '')) AS distinct_ips,
			COALESCE(MAX(NULLIF(r.client_ip, '')), '') AS sample_ip,
			MAX(ti.created_at) AS last_seen
		FROM tool_invocations ti
		LEFT JOIN request_logs r ON r.id = ti.request_id
		WHERE ` + whereSQL + `
		GROUP BY COALESCE(NULLIF(ti.server_label, ''), '(none)'), ti.tool_name
		ORDER BY calls DESC, results DESC, definitions DESC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []MCPToolStat{}
	for rows.Next() {
		var t MCPToolStat
		var isMCP int
		if err := rows.Scan(&t.ServerLabel, &t.ToolName, &isMCP, &t.Definitions, &t.Calls, &t.Results, &t.Errors, &t.DistinctKeys, &t.DistinctIPs, &t.SampleIP, &t.LastSeen); err != nil {
			return nil, err
		}
		t.IsMCP = isMCP == 1
		if t.Results > 0 {
			t.ErrorRate = float64(t.Errors) / float64(t.Results)
		}
		result = append(result, t)
	}
	return result, rows.Err()
}

// ListMCPServers groups invocations by MCP server label.
func (s *SQLStore) ListMCPServers(ctx context.Context, f ToolFilter) ([]MCPServerStat, error) {
	whereSQL, args := f.whereAliased("ti")
	query := s.bind(`
		SELECT COALESCE(NULLIF(ti.server_label, ''), '(none)') AS server,
			MAX(ti.is_mcp) AS is_mcp,
			COUNT(DISTINCT ti.tool_name) AS tools,
			SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END) AS calls,
			SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END) AS errors,
			COUNT(DISTINCT NULLIF(ti.api_key_id, '')) AS distinct_keys,
			COUNT(DISTINCT NULLIF(r.client_ip, '')) AS distinct_ips,
			COALESCE(MAX(NULLIF(r.client_ip, '')), '') AS sample_ip,
			MAX(ti.created_at) AS last_seen
		FROM tool_invocations ti
		LEFT JOIN request_logs r ON r.id = ti.request_id
		WHERE ` + whereSQL + `
		GROUP BY COALESCE(NULLIF(ti.server_label, ''), '(none)')
		ORDER BY calls DESC, tools DESC`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []MCPServerStat{}
	for rows.Next() {
		var srv MCPServerStat
		var isMCP int
		var results int64
		// reuse calls slot; compute error rate against calls+results via a second pass
		if err := rows.Scan(&srv.ServerLabel, &isMCP, &srv.Tools, &srv.Calls, &srv.Errors, &srv.DistinctKeys, &srv.DistinctIPs, &srv.SampleIP, &srv.LastSeen); err != nil {
			return nil, err
		}
		srv.IsMCP = isMCP == 1
		denom := srv.Calls
		if denom == 0 {
			denom = results
		}
		if denom > 0 {
			srv.ErrorRate = float64(srv.Errors) / float64(denom)
		}
		result = append(result, srv)
	}
	return result, rows.Err()
}

// ToolsForRequest returns the tool invocations for a single request (for trace detail).
func (s *SQLStore) ToolsForRequest(ctx context.Context, requestID string) ([]ToolInvocation, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, trace_id, COALESCE(api_key_id, ''), COALESCE(server_label, ''), tool_name, source, is_mcp, is_error, COALESCE(arg_sensitive, 0), COALESCE(arg_hash, ''), created_at
		FROM tool_invocations WHERE request_id = ? ORDER BY created_at ASC, source ASC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ToolInvocation{}
	for rows.Next() {
		var t ToolInvocation
		var isMCP, isErr, argSensitive int
		var createdAt string
		if err := rows.Scan(&t.ID, &t.RequestID, &t.TraceID, &t.APIKeyID, &t.ServerLabel, &t.ToolName, &t.Source, &isMCP, &isErr, &argSensitive, &t.ArgHash, &createdAt); err != nil {
			return nil, err
		}
		t.IsMCP = isMCP == 1
		t.IsError = isErr == 1
		t.ArgSensitive = argSensitive == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			t.CreatedAt = parsed
		}
		result = append(result, t)
	}
	return result, rows.Err()
}

// RequestsForTool returns recent requests that touched the given server/tool.
func (s *SQLStore) RequestsForTool(ctx context.Context, server, tool string, errorsOnly bool, limit int) ([]RecentRequest, error) {
	return s.RecentRequests(ctx, RequestFilter{
		Limit:          limit,
		ToolServer:     server,
		ToolName:       tool,
		ToolErrorsOnly: errorsOnly,
	})
}

// ToolMetricsSince returns (calls, errors) within a window for alerting.
func (s *SQLStore) ToolMetricsSince(ctx context.Context, since time.Time) (calls int64, errors int64, err error) {
	row := s.db.QueryRowContext(ctx, s.bind(`
		SELECT SUM(CASE WHEN source = 'call' THEN 1 ELSE 0 END),
			SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END)
		FROM tool_invocations WHERE created_at >= ?`), since.UTC().Format(time.RFC3339Nano))
	var c, e *int64
	if err = row.Scan(&c, &e); err != nil {
		return 0, 0, err
	}
	if c != nil {
		calls = *c
	}
	if e != nil {
		errors = *e
	}
	return calls, errors, nil
}

// MCPSummary gives top-line counts for the dashboard / stats endpoint.
type MCPSummary struct {
	TotalCalls    int64 `json:"total_calls"`
	TotalErrors   int64 `json:"total_errors"`
	DistinctTools int64 `json:"distinct_tools"`
	MCPServers    int64 `json:"mcp_servers"`
}

func (s *SQLStore) MCPSummary(ctx context.Context) (MCPSummary, error) {
	var sum MCPSummary
	err := s.db.QueryRowContext(ctx, `
		SELECT
			SUM(CASE WHEN source = 'call' THEN 1 ELSE 0 END),
			SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END),
			COUNT(DISTINCT tool_name),
			COUNT(DISTINCT CASE WHEN is_mcp = 1 THEN server_label END)
		FROM tool_invocations`).Scan(&nullableInt64{&sum.TotalCalls}, &nullableInt64{&sum.TotalErrors}, &sum.DistinctTools, &sum.MCPServers)
	if err != nil {
		return sum, err
	}
	return sum, nil
}

// nullableInt64 scans a possibly-NULL SUM() into an int64 target.
type nullableInt64 struct{ dst *int64 }

func (n *nullableInt64) Scan(src any) error {
	if src == nil {
		*n.dst = 0
		return nil
	}
	switch v := src.(type) {
	case int64:
		*n.dst = v
	case int:
		*n.dst = int64(v)
	case float64:
		*n.dst = int64(v)
	}
	return nil
}
