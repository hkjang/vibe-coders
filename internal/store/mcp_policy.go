package store

import (
	"context"
	"time"
)

func (s *SQLStore) ListMCPPolicies(ctx context.Context) ([]MCPPolicy, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT server_label, mode, COALESCE(note,''), created_at, updated_at
		FROM mcp_policies ORDER BY server_label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []MCPPolicy{}
	for rows.Next() {
		var p MCPPolicy
		var createdAt, updatedAt string
		if err := rows.Scan(&p.ServerLabel, &p.Mode, &p.Note, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			p.CreatedAt = parsed
		}
		if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
			p.UpdatedAt = parsed
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertMCPPolicy(ctx context.Context, p MCPPolicy) error {
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO mcp_policies (server_label, mode, note, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(server_label) DO UPDATE SET mode = excluded.mode, note = excluded.note, updated_at = excluded.updated_at`),
		p.ServerLabel, p.Mode, p.Note, formatTime(p.CreatedAt), formatTime(p.UpdatedAt))
	return err
}

func (s *SQLStore) DeleteMCPPolicy(ctx context.Context, server string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM mcp_policies WHERE server_label = ?`), server)
	return err
}

// MCPPolicyMap returns server_label -> mode for fast enforcement lookups.
func (s *SQLStore) MCPPolicyMap(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT server_label, mode FROM mcp_policies`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var server, mode string
		if err := rows.Scan(&server, &mode); err != nil {
			return nil, err
		}
		out[server] = mode
	}
	return out, rows.Err()
}

// MCPCatalog returns the per-server tool catalog. Tools first seen within `newWindow`
// are flagged IsNew; tools not seen within `staleWindow` are flagged IsStale.
func (s *SQLStore) MCPCatalog(ctx context.Context, server string, newWindow, staleWindow time.Duration) ([]MCPCatalogEntry, error) {
	where := "1=1"
	args := []any{}
	if server != "" {
		where = "server_label = ?"
		args = append(args, server)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT server_label, tool_name, is_mcp, first_seen, last_seen
		FROM mcp_tool_catalog WHERE `+where+`
		ORDER BY server_label ASC, tool_name ASC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	newCutoff := now.Add(-newWindow)
	staleCutoff := now.Add(-staleWindow)
	result := []MCPCatalogEntry{}
	for rows.Next() {
		var e MCPCatalogEntry
		var isMCP int
		if err := rows.Scan(&e.ServerLabel, &e.ToolName, &isMCP, &e.FirstSeen, &e.LastSeen); err != nil {
			return nil, err
		}
		e.IsMCP = isMCP == 1
		if t, err := time.Parse(time.RFC3339Nano, e.FirstSeen); err == nil && t.After(newCutoff) {
			e.IsNew = true
		}
		if staleWindow > 0 {
			if t, err := time.Parse(time.RFC3339Nano, e.LastSeen); err == nil && t.Before(staleCutoff) {
				e.IsStale = true
			}
		}
		result = append(result, e)
	}
	return result, rows.Err()
}

// CountNewCatalogTools returns how many catalog tools were first seen since `cutoff`.
func (s *SQLStore) CountNewCatalogTools(ctx context.Context, since time.Time) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM mcp_tool_catalog WHERE first_seen >= ?`),
		since.UTC().Format(time.RFC3339Nano)).Scan(&n)
	return n, err
}

// SessionToolLoops finds (session, server, tool) combinations called at least
// `threshold` times within the window — a strong signal of an agent stuck in a loop.
func (s *SQLStore) SessionToolLoops(ctx context.Context, since time.Time, threshold int, limit int) ([]SessionToolLoop, error) {
	if threshold <= 0 {
		threshold = 10
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(`
		SELECT COALESCE(NULLIF(r.session_id, ''), 'trace:' || r.trace_id) AS session_id,
			COALESCE(NULLIF(ti.server_label, ''), '(none)') AS server,
			ti.tool_name,
			MAX(ti.is_mcp) AS is_mcp,
			SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END) AS calls,
			SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END) AS errors,
			MAX(COALESCE(r.api_key_id, '')) AS api_key_id,
			MIN(ti.created_at) AS first_seen,
			MAX(ti.created_at) AS last_seen
		FROM tool_invocations ti
		JOIN request_logs r ON r.id = ti.request_id
		WHERE ti.created_at >= ? AND ti.source = 'call'
		GROUP BY COALESCE(NULLIF(r.session_id, ''), 'trace:' || r.trace_id),
			COALESCE(NULLIF(ti.server_label, ''), '(none)'), ti.tool_name
		HAVING SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END) >= ?
		ORDER BY calls DESC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano), threshold, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SessionToolLoop{}
	for rows.Next() {
		var l SessionToolLoop
		var isMCP int
		if err := rows.Scan(&l.SessionID, &l.ServerLabel, &l.ToolName, &isMCP, &l.Calls, &l.Errors, &l.APIKeyID, &l.FirstSeen, &l.LastSeen); err != nil {
			return nil, err
		}
		l.IsMCP = isMCP == 1
		result = append(result, l)
	}
	return result, rows.Err()
}

// MaxSessionToolCallsSince returns the highest single (session,tool) call count in the
// window — used by the tool_loop alert metric.
func (s *SQLStore) MaxSessionToolCallsSince(ctx context.Context, since time.Time) (int64, error) {
	query := s.bind(`
		SELECT COALESCE(MAX(cnt), 0) FROM (
			SELECT SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END) AS cnt
			FROM tool_invocations ti
			JOIN request_logs r ON r.id = ti.request_id
			WHERE ti.created_at >= ? AND ti.source = 'call'
			GROUP BY COALESCE(NULLIF(r.session_id, ''), 'trace:' || r.trace_id), ti.server_label, ti.tool_name
		) x`)
	var max int64
	if err := s.db.QueryRowContext(ctx, query, since.UTC().Format(time.RFC3339Nano)).Scan(&max); err != nil {
		return 0, err
	}
	return max, nil
}
