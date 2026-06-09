package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ---------- runtime flags ----------

func (s *SQLStore) GetFlag(ctx context.Context, key string) (RuntimeFlag, bool, error) {
	var flag RuntimeFlag
	var updatedAt string
	var updatedBy sql.NullString
	var note sql.NullString
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT key, value, updated_at, updated_by, note FROM runtime_flags WHERE key = ?`), key).
		Scan(&flag.Key, &flag.Value, &updatedAt, &updatedBy, &note)
	if err == sql.ErrNoRows {
		return RuntimeFlag{Key: key}, false, nil
	}
	if err != nil {
		return RuntimeFlag{}, false, err
	}
	if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
		flag.UpdatedAt = parsed
	}
	flag.UpdatedBy = updatedBy.String
	flag.Note = note.String
	return flag, true, nil
}

func (s *SQLStore) SetFlag(ctx context.Context, flag RuntimeFlag) error {
	if flag.UpdatedAt.IsZero() {
		flag.UpdatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO runtime_flags (key, value, updated_at, updated_by, note)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by, note = excluded.note`),
		flag.Key, flag.Value, formatTime(flag.UpdatedAt), flag.UpdatedBy, flag.Note)
	return err
}

// ---------- alert rules ----------

func (s *SQLStore) ListAlertRules(ctx context.Context) ([]AlertRule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, metric, window_seconds, threshold, scope, scope_value,
		COALESCE(webhook_url, ''), enabled, COALESCE(note, ''), created_at, last_fired_at, last_value
		FROM alert_rules
		ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []AlertRule{}
	for rows.Next() {
		var rule AlertRule
		var enabled int
		var createdAt string
		var lastFiredAt sql.NullString
		var lastValue sql.NullFloat64
		if err := rows.Scan(&rule.ID, &rule.Name, &rule.Metric, &rule.WindowSeconds, &rule.Threshold,
			&rule.Scope, &rule.ScopeValue, &rule.WebhookURL, &enabled, &rule.Note,
			&createdAt, &lastFiredAt, &lastValue); err != nil {
			return nil, err
		}
		rule.Enabled = enabled == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			rule.CreatedAt = parsed
		}
		if lastFiredAt.Valid {
			if parsed, err := time.Parse(time.RFC3339Nano, lastFiredAt.String); err == nil {
				rule.LastFiredAt = &parsed
			}
		}
		if lastValue.Valid {
			rule.LastValue = lastValue.Float64
		}
		result = append(result, rule)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertAlertRule(ctx context.Context, rule AlertRule) error {
	if rule.CreatedAt.IsZero() {
		rule.CreatedAt = time.Now().UTC()
	}
	query := s.bind(`INSERT INTO alert_rules (id, name, metric, window_seconds, threshold, scope, scope_value, webhook_url, enabled, note, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			metric = excluded.metric,
			window_seconds = excluded.window_seconds,
			threshold = excluded.threshold,
			scope = excluded.scope,
			scope_value = excluded.scope_value,
			webhook_url = excluded.webhook_url,
			enabled = excluded.enabled,
			note = excluded.note`)
	_, err := s.db.ExecContext(ctx, query,
		rule.ID, rule.Name, rule.Metric, rule.WindowSeconds, rule.Threshold,
		rule.Scope, rule.ScopeValue, rule.WebhookURL, boolInt(rule.Enabled), rule.Note,
		formatTime(rule.CreatedAt))
	return err
}

func (s *SQLStore) UpdateAlertFireState(ctx context.Context, id string, value float64, firedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE alert_rules SET last_fired_at = ?, last_value = ? WHERE id = ?`),
		formatTime(firedAt), value, id)
	return err
}

func (s *SQLStore) DeleteAlertRule(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM alert_rules WHERE id = ?`), id)
	return err
}

func (s *SQLStore) InsertAlertEvent(ctx context.Context, event AlertEvent) error {
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO alert_events (id, rule_id, rule_name, metric, value, threshold, delivered, delivery_error, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		event.ID, event.RuleID, event.RuleName, event.Metric, event.Value, event.Threshold,
		boolInt(event.Delivered), event.DeliveryError, formatTime(event.CreatedAt))
	return err
}

func (s *SQLStore) ListAlertEvents(ctx context.Context, limit int) ([]AlertEvent, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, rule_id, rule_name, metric, value, threshold, delivered, COALESCE(delivery_error, ''), created_at
		FROM alert_events ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []AlertEvent{}
	for rows.Next() {
		var e AlertEvent
		var delivered int
		var createdAt string
		if err := rows.Scan(&e.ID, &e.RuleID, &e.RuleName, &e.Metric, &e.Value, &e.Threshold,
			&delivered, &e.DeliveryError, &createdAt); err != nil {
			return nil, err
		}
		e.Delivered = delivered == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			e.CreatedAt = parsed
		}
		result = append(result, e)
	}
	return result, rows.Err()
}

// MetricSince computes alert metrics for a window/scope.
func (s *SQLStore) MetricSince(ctx context.Context, scope, scopeValue string, since time.Time) (AlertMetricSnapshot, error) {
	var snapshot AlertMetricSnapshot
	where := []string{"r.created_at >= ?"}
	args := []any{since.UTC().Format(time.RFC3339Nano)}
	switch scope {
	case "api_key":
		where = append(where, "r.api_key_id = ?")
		args = append(args, scopeValue)
	case "team":
		where = append(where, `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned') = ?`)
		args = append(args, scopeValue)
	case "ip":
		where = append(where, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		args = append(args, scopeValue)
	case "model":
		where = append(where, "r.model = ?")
		args = append(args, scopeValue)
	case "", "global":
		// no extra
	default:
		return snapshot, fmt.Errorf("unsupported alert scope %q", scope)
	}
	query := s.bind(`SELECT COUNT(r.id), COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(t.estimated_cost), 0), COALESCE(SUM(t.total_tokens), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE ` + strings.Join(where, " AND "))
	row := s.db.QueryRowContext(ctx, query, args...)
	if err := row.Scan(&snapshot.Requests, &snapshot.Errors, &snapshot.CostKRW, &snapshot.Tokens); err != nil {
		return snapshot, err
	}

	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT r.latency_ms, COALESCE(r.first_chunk_ms, 0)
		FROM request_logs r
		WHERE `+strings.Join(where, " AND ")), args...)
	if err != nil {
		return snapshot, err
	}
	defer rows.Close()

	latencies := []int64{}
	firstChunks := []int64{}
	for rows.Next() {
		var latency int64
		var firstChunk int64
		if err := rows.Scan(&latency, &firstChunk); err != nil {
			return snapshot, err
		}
		latencies = append(latencies, latency)
		firstChunks = append(firstChunks, firstChunk)
	}
	if err := rows.Err(); err != nil {
		return snapshot, err
	}
	snapshot.LatencyP95MS = percentile95MS(latencies)
	snapshot.FirstChunkP95MS = percentile95MS(firstChunks)

	evalWhere := []string{"e.created_at >= ?"}
	evalArgs := []any{since.UTC().Format(time.RFC3339Nano)}
	switch scope {
	case "api_key":
		evalWhere = append(evalWhere, "r.api_key_id = ?")
		evalArgs = append(evalArgs, scopeValue)
	case "team":
		evalWhere = append(evalWhere, `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned') = ?`)
		evalArgs = append(evalArgs, scopeValue)
	case "ip":
		evalWhere = append(evalWhere, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		evalArgs = append(evalArgs, scopeValue)
	case "model":
		evalWhere = append(evalWhere, "r.model = ?")
		evalArgs = append(evalArgs, scopeValue)
	case "", "global":
		// no extra
	default:
		return snapshot, fmt.Errorf("unsupported alert scope %q", scope)
	}
	evalQuery := s.bind(`SELECT COUNT(e.id), COALESCE(SUM(CASE WHEN e.passed = 0 THEN 1 ELSE 0 END), 0)
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE ` + strings.Join(evalWhere, " AND "))
	if err := s.db.QueryRowContext(ctx, evalQuery, evalArgs...).Scan(&snapshot.LLMEvaluations, &snapshot.LLMEvalFailures); err != nil {
		return snapshot, err
	}

	// tool/MCP metrics over the same scope+window (joined to request_logs for scoping).
	// Build a dedicated WHERE so the time column references tool_invocations (ti), not e.
	toolWhere := []string{"ti.created_at >= ?"}
	toolArgs := []any{since.UTC().Format(time.RFC3339Nano)}
	switch scope {
	case "api_key":
		toolWhere = append(toolWhere, "r.api_key_id = ?")
		toolArgs = append(toolArgs, scopeValue)
	case "team":
		toolWhere = append(toolWhere, `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned') = ?`)
		toolArgs = append(toolArgs, scopeValue)
	case "ip":
		toolWhere = append(toolWhere, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		toolArgs = append(toolArgs, scopeValue)
	case "model":
		toolWhere = append(toolWhere, "r.model = ?")
		toolArgs = append(toolArgs, scopeValue)
	case "", "global":
		// no extra
	}
	toolQuery := s.bind(`SELECT
			COALESCE(SUM(CASE WHEN ti.source = 'call' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END), 0)
		FROM tool_invocations ti
		JOIN request_logs r ON r.id = ti.request_id
		WHERE ` + strings.Join(toolWhere, " AND "))
	if err := s.db.QueryRowContext(ctx, toolQuery, toolArgs...).Scan(&snapshot.ToolCalls, &snapshot.ToolErrors); err != nil {
		return snapshot, err
	}

	// loop signal: highest single (session, tool) call count in the window (scope-independent).
	if maxLoop, err := s.MaxSessionToolCallsSince(ctx, since); err == nil {
		snapshot.MaxSessionToolCall = maxLoop
	}
	// catalog drift: number of tools first observed within the window (scope-independent).
	if newTools, err := s.CountNewCatalogTools(ctx, since); err == nil {
		snapshot.NewCatalogTools = newTools
	}
	// anomaly: strongest model cost/latency z-score, baseline 7d vs the alert window.
	recentDur := time.Since(since)
	if recentDur > 0 && recentDur < 24*time.Hour {
		if z, err := s.MaxAnomalyZ(ctx, 7*24*time.Hour, recentDur); err == nil {
			snapshot.MaxAnomalyZ = z
		}
	}
	// budget: largest projected month-end spend ratio across budgets (scope-independent).
	if ratio, err := s.MaxBudgetProjectedRatio(ctx, time.Now()); err == nil {
		snapshot.MaxBudgetRatio = ratio
	}
	return snapshot, nil
}

func percentile95MS(values []int64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	idx := int(float64(len(values)-1) * 0.95)
	return float64(values[idx])
}
