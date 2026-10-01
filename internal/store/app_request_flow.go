package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

const (
	AppRequestFlowCandidateLimit = 200
	AppRequestFlowChildLimit     = 100
)

// AppRequestFlowScope identifies an exact recorded request, not a raw trace ID
// or a capability. Every metadata query independently applies its team boundary.
type AppRequestFlowScope struct {
	RequestID  string
	CreatedAt  time.Time
	Teams      []string
	TeamScoped bool
}

type AppRequestFlowRoot struct {
	RequestID  string
	CreatedAt  string
	StatusCode *int64
	LatencyMS  *int64
}

// These internal rows intentionally have no original prompt, argument, SQL,
// header, error, hash or detail fields. Their bounded text still needs the
// proxy's credential-aware projection before it may be serialized.
type AppRequestFlowTool struct {
	ID, ToolName, ServerLabel, Source, CreatedAt string
	IsMCP, IsError                               *int64
}

type AppRequestFlowText2SQL struct {
	ID, Stage, Status, CreatedAt string
	LatencyMS                    *int64
}

func (s *SQLStore) appRequestFlowCandidatesQuery(at time.Time) (string, []any) {
	createdAt := appRequestCreatedAtExpr("r.created_at")
	valid := renderForDialect(appRequestValidRowPredicate("r.id", "r.created_at"), s.dialect)
	// The whole bucket is either accepted or rejected on overflow; its order
	// has no meaning. An ORDER BY on the normalized expression can make SQLite
	// sort the entire equality bucket before LIMIT despite using this index.
	return s.bind(`SELECT r.id FROM request_logs r WHERE ` + valid + ` AND ` + createdAt + ` = ?
		LIMIT ?`), []any{appRequestFixedTime(at), AppRequestFlowCandidateLimit + 1}
}

// AppRequestFlowCandidates reads only bounded IDs from the existing partial
// timestamp index. Callers must reject overflow before looking for a reference
// match; neither team filtering nor child joins belong in this global budget.
func (s *SQLStore) AppRequestFlowCandidates(ctx context.Context, at time.Time) ([]string, bool, error) {
	query, args := s.appRequestFlowCandidatesQuery(at)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, false, err
		}
		items = append(items, id)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(items) > AppRequestFlowCandidateLimit
	if truncated {
		items = items[:AppRequestFlowCandidateLimit]
	}
	return items, truncated, nil
}

func (s *SQLStore) appRequestFlowScopeCondition(scope AppRequestFlowScope) (string, []any) {
	valid := renderForDialect(appRequestValidRowPredicate("r.id", "r.created_at"), s.dialect)
	requestKey := renderForDialect(appRequestBoundedTextPredicate("r.api_key_id"), s.dialect)
	keyRow := renderForDialect(appRequestBoundedTextPredicate("k.id")+" AND "+appRequestBoundedTextPredicate("k.team"), s.dialect)
	where := []string{"r.id = ?", appRequestCreatedAtExpr("r.created_at") + " = ?", valid}
	args := []any{scope.RequestID, appRequestFixedTime(scope.CreatedAt)}
	where, args = appendRequestTeamConditionWithPredicates(where, args, "", scope.Teams, scope.TeamScoped, requestKey, keyRow, s.dialect == "sqlite")
	return strings.Join(where, " AND "), args
}

// SQLite's affinity permits corrupt text/real/blob values in integer columns.
// Discard them inside SQL instead of decoding arbitrary text as a number. The
// PostgreSQL schema enforces integer types; NULL remains unknown on both engines.
func (s *SQLStore) appRequestFlowInteger(column string) string {
	if s.dialect == "sqlite" {
		return "CASE WHEN typeof(" + column + ") = 'integer' THEN " + column + " ELSE NULL END"
	}
	return column
}

func (s *SQLStore) appRequestFlowRootQuery(scope AppRequestFlowScope) (string, []any) {
	where, args := s.appRequestFlowScopeCondition(scope)
	return s.bind(`SELECT r.id, ` + appRequestCreatedAtExpr("r.created_at") + `,
		` + s.appRequestFlowInteger("r.status_code") + `, ` + s.appRequestFlowInteger("r.latency_ms") + `
		FROM request_logs r WHERE ` + where), args
}

func (s *SQLStore) AppRequestFlowRoot(ctx context.Context, scope AppRequestFlowScope) (AppRequestFlowRoot, error) {
	query, args := s.appRequestFlowRootQuery(scope)
	var item AppRequestFlowRoot
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&item.RequestID, &item.CreatedAt, &item.StatusCode, &item.LatencyMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AppRequestFlowRoot{}, ErrNotFound
		}
		return AppRequestFlowRoot{}, err
	}
	return item, nil
}

func (s *SQLStore) appRequestFlowToolsQuery(scope AppRequestFlowScope) (string, []any) {
	where, args := s.appRequestFlowScopeCondition(scope)
	args = append([]any{scope.RequestID, AppRequestFlowChildLimit + 1}, args...)
	// LIMIT is inside the derived table, before authorization's outer WHERE and
	// all proxy display filtering/sorting. Do not add a child validity/source
	// predicate or ORDER BY here: the existing index covers only request_id.
	return s.bind(`SELECT c.id, c.tool_name, c.server_label, c.source, c.created_at, c.is_mcp, c.is_error
		FROM (SELECT substr(COALESCE(t.id, ''), 1, 513) AS id,
			substr(COALESCE(t.tool_name, ''), 1, 257) AS tool_name,
			substr(COALESCE(t.server_label, ''), 1, 257) AS server_label,
			substr(COALESCE(t.source, ''), 1, 33) AS source,
			substr(COALESCE(t.created_at, ''), 1, 36) AS created_at,
			` + s.appRequestFlowInteger("t.is_mcp") + ` AS is_mcp,
			` + s.appRequestFlowInteger("t.is_error") + ` AS is_error
			FROM tool_invocations t WHERE t.request_id = ? LIMIT ?) c
		WHERE EXISTS (SELECT 1 FROM request_logs r WHERE ` + where + `)`), args
}

// AppRequestFlowTools returns the first bounded candidate subset, not the
// earliest tools. Non-call/invalid rows consume the budget and are not refilled.
func (s *SQLStore) AppRequestFlowTools(ctx context.Context, scope AppRequestFlowScope) ([]AppRequestFlowTool, bool, error) {
	query, args := s.appRequestFlowToolsQuery(scope)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []AppRequestFlowTool{}
	for rows.Next() {
		var item AppRequestFlowTool
		if err := rows.Scan(&item.ID, &item.ToolName, &item.ServerLabel, &item.Source, &item.CreatedAt, &item.IsMCP, &item.IsError); err != nil {
			return nil, false, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(items) > AppRequestFlowChildLimit
	if truncated {
		items = items[:AppRequestFlowChildLimit]
	}
	return items, truncated, nil
}

func (s *SQLStore) appRequestFlowText2SQLQuery(scope AppRequestFlowScope) (string, []any) {
	where, args := s.appRequestFlowScopeCondition(scope)
	args = append([]any{scope.RequestID, AppRequestFlowChildLimit + 1}, args...)
	return s.bind(`SELECT c.id, c.stage, c.status, c.created_at, c.latency_ms
		FROM (SELECT substr(COALESCE(t.id, ''), 1, 513) AS id,
			substr(COALESCE(t.stage, ''), 1, 65) AS stage,
			substr(COALESCE(t.status, ''), 1, 33) AS status,
			substr(COALESCE(t.created_at, ''), 1, 36) AS created_at,
			` + s.appRequestFlowInteger("t.latency_ms") + ` AS latency_ms
			FROM text2sql_spans t WHERE t.request_id = ? LIMIT ?) c
		WHERE EXISTS (SELECT 1 FROM request_logs r WHERE ` + where + `)`), args
}

func (s *SQLStore) AppRequestFlowText2SQL(ctx context.Context, scope AppRequestFlowScope) ([]AppRequestFlowText2SQL, bool, error) {
	query, args := s.appRequestFlowText2SQLQuery(scope)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []AppRequestFlowText2SQL{}
	for rows.Next() {
		var item AppRequestFlowText2SQL
		if err := rows.Scan(&item.ID, &item.Stage, &item.Status, &item.CreatedAt, &item.LatencyMS); err != nil {
			return nil, false, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(items) > AppRequestFlowChildLimit
	if truncated {
		items = items[:AppRequestFlowChildLimit]
	}
	return items, truncated, nil
}
