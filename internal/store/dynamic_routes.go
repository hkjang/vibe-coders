package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// DynamicRoute is a named, versioned routing graph a client calls as the model
// "dynamic/<name>". The graph itself lives in dynamic_route_versions: every save
// appends a version, and only the version recorded in DeployedVersion serves
// traffic. Rolling back is deploying an earlier version, so a bad change is undone
// without rebuilding it by hand.
type DynamicRoute struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	Enabled         bool   `json:"enabled"`
	DeployedVersion int    `json:"deployed_version"`
	LatestVersion   int    `json:"latest_version"`
	DeployedAt      string `json:"deployed_at,omitempty"`
	DeployedBy      string `json:"deployed_by,omitempty"`
	CreatedBy       string `json:"created_by"`
	UpdatedBy       string `json:"updated_by"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

// DynamicRouteVersion is one saved graph. Graph is the normalized JSON document
// ({"elements": [...]}) that the proxy validated before saving it.
type DynamicRouteVersion struct {
	RouteID   string `json:"route_id"`
	Version   int    `json:"version"`
	Graph     string `json:"-"`
	Note      string `json:"note"`
	CreatedBy string `json:"created_by"`
	CreatedAt string `json:"created_at"`
}

// DeployedDynamicRoute is what the request path needs: the route row and the graph
// of the version it serves.
type DeployedDynamicRoute struct {
	Route DynamicRoute
	Graph string
}

// DynamicRouteRequest records how one request travelled through a route: which
// version served it, the elements it passed and what each decided, and the model
// that finally answered. It is written in the same transaction as the request log
// and purged with it.
type DynamicRouteRequest struct {
	RequestID      string    `json:"request_id"`
	RouteID        string    `json:"route_id"`
	RouteName      string    `json:"route_name"`
	Version        int       `json:"version"`
	PathJSON       string    `json:"-"`
	MetadataJSON   string    `json:"-"`
	FinalElementID string    `json:"final_element_id"`
	FinalModel     string    `json:"final_model"`
	FinalProvider  string    `json:"final_provider"`
	Fallbacks      int       `json:"fallbacks"`
	Attempts       int       `json:"attempts"`
	Outcome        string    `json:"outcome"`
	StatusCode     int       `json:"status_code"`
	LatencyMS      int64     `json:"latency_ms"`
	CostKRW        float64   `json:"cost_krw"`
	CreatedAt      time.Time `json:"created_at"`
}

// DynamicRouteCounter is the usage a rate element has counted in one window for one
// scope (a hashed metadata value, or "" when the request carried none).
type DynamicRouteCounter struct {
	RouteID      string  `json:"route_id"`
	ElementID    string  `json:"element_id"`
	ScopeKey     string  `json:"scope_key"`
	WindowStart  int64   `json:"window_start"`
	WindowEnd    int64   `json:"window_end"`
	RequestCount int64   `json:"request_count"`
	CostKRW      float64 `json:"cost_krw"`
	UpdatedAt    string  `json:"updated_at"`
}

// DynamicRouteTrafficRow aggregates recent requests of a route by version and by the
// element that ended them.
type DynamicRouteTrafficRow struct {
	Version        int     `json:"version"`
	FinalElementID string  `json:"final_element_id"`
	FinalModel     string  `json:"final_model"`
	Outcome        string  `json:"outcome"`
	Requests       int64   `json:"requests"`
	Fallbacks      int64   `json:"fallbacks"`
	AvgLatencyMS   float64 `json:"avg_latency_ms"`
	CostKRW        float64 `json:"cost_krw"`
}

var (
	ErrDynamicRouteNotFound  = errors.New("dynamic route not found")
	ErrDynamicRouteNameTaken = errors.New("dynamic route name is already used")
	// ErrDynamicRouteConflict means the row changed after the caller read it: another
	// operator saved a version or deployed in between. The caller re-reads and decides.
	ErrDynamicRouteConflict       = errors.New("dynamic route changed concurrently")
	ErrDynamicRouteVersionMissing = errors.New("dynamic route version not found")
)

const dynamicRouteColumns = `id, name, description, enabled, deployed_version, latest_version,
	COALESCE(deployed_at, ''), COALESCE(deployed_by, ''), COALESCE(created_by, ''), COALESCE(updated_by, ''), created_at, updated_at`

func scanDynamicRoute(scan func(...any) error) (DynamicRoute, error) {
	var route DynamicRoute
	var enabled int
	err := scan(&route.ID, &route.Name, &route.Description, &enabled, &route.DeployedVersion, &route.LatestVersion,
		&route.DeployedAt, &route.DeployedBy, &route.CreatedBy, &route.UpdatedBy, &route.CreatedAt, &route.UpdatedAt)
	route.Enabled = enabled != 0
	return route, err
}

func dynamicRouteUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "unique constraint") || strings.Contains(lower, "duplicate key")
}

// CreateDynamicRoute inserts a route together with its first version. The route
// starts undeployed: a new graph serves no traffic until an operator deploys it.
func (s *SQLStore) CreateDynamicRoute(ctx context.Context, route DynamicRoute, graph, note string) (DynamicRoute, error) {
	now := formatTime(time.Now())
	route.CreatedAt, route.UpdatedAt = now, now
	route.UpdatedBy = route.CreatedBy
	route.LatestVersion, route.DeployedVersion = 1, 0
	route.DeployedAt, route.DeployedBy = "", ""
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DynamicRoute{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var taken int
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM dynamic_routes WHERE name = ?`), route.Name).Scan(&taken); err != nil {
		return DynamicRoute{}, err
	}
	if taken > 0 {
		return DynamicRoute{}, ErrDynamicRouteNameTaken
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO dynamic_routes
		(id, name, description, enabled, deployed_version, latest_version, created_by, updated_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`),
		cleanArgs([]any{route.ID, route.Name, route.Description, boolInt(route.Enabled), route.CreatedBy, route.UpdatedBy, now, now})...); err != nil {
		if dynamicRouteUniqueViolation(err) {
			return DynamicRoute{}, ErrDynamicRouteNameTaken
		}
		return DynamicRoute{}, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO dynamic_route_versions
		(route_id, version, graph_json, note, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?)`),
		cleanArgs([]any{route.ID, graph, note, route.CreatedBy, now})...); err != nil {
		return DynamicRoute{}, err
	}
	if err := tx.Commit(); err != nil {
		return DynamicRoute{}, err
	}
	return route, nil
}

// ListDynamicRoutes returns every route, by name.
func (s *SQLStore) ListDynamicRoutes(ctx context.Context) ([]DynamicRoute, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+dynamicRouteColumns+` FROM dynamic_routes ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DynamicRoute{}
	for rows.Next() {
		route, err := scanDynamicRoute(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, route)
	}
	return out, rows.Err()
}

// GetDynamicRoute returns one route by id.
func (s *SQLStore) GetDynamicRoute(ctx context.Context, id string) (DynamicRoute, bool, error) {
	route, err := scanDynamicRoute(s.db.QueryRowContext(ctx, s.bind(`SELECT `+dynamicRouteColumns+` FROM dynamic_routes WHERE id = ?`), id).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return DynamicRoute{}, false, nil
	}
	if err != nil {
		return DynamicRoute{}, false, err
	}
	return route, true, nil
}

// UpdateDynamicRouteSettings changes the description and the enabled switch. Neither
// creates a version: they say whether and how the route is offered, not how it routes.
func (s *SQLStore) UpdateDynamicRouteSettings(ctx context.Context, id, description string, enabled bool, actor string) (DynamicRoute, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE dynamic_routes SET description = ?, enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?`),
		cleanArgs([]any{description, boolInt(enabled), actor, formatTime(time.Now()), id})...)
	if err != nil {
		return DynamicRoute{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return DynamicRoute{}, ErrDynamicRouteNotFound
	}
	route, found, err := s.GetDynamicRoute(ctx, id)
	if err != nil {
		return DynamicRoute{}, err
	}
	if !found {
		return DynamicRoute{}, ErrDynamicRouteNotFound
	}
	return route, nil
}

// DeleteDynamicRoute removes a route, its versions and its counters. The per-request
// history stays until retention purges it with the request logs it explains.
func (s *SQLStore) DeleteDynamicRoute(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, s.bind(`DELETE FROM dynamic_routes WHERE id = ?`), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrDynamicRouteNotFound
	}
	for _, query := range []string{
		`DELETE FROM dynamic_route_versions WHERE route_id = ?`,
		`DELETE FROM dynamic_route_counters WHERE route_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, s.bind(query), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SaveDynamicRouteVersion appends a version on top of baseVersion. When someone else
// saved since the caller read the route, nothing is written and the caller gets
// ErrDynamicRouteConflict instead of silently replacing a colleague's change.
func (s *SQLStore) SaveDynamicRouteVersion(ctx context.Context, id string, baseVersion int, graph, note, actor string) (DynamicRouteVersion, error) {
	now := formatTime(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DynamicRouteVersion{}, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, s.bind(`UPDATE dynamic_routes SET latest_version = latest_version + 1, updated_by = ?, updated_at = ?
		WHERE id = ? AND latest_version = ?`), cleanArgs([]any{actor, now, id, baseVersion})...)
	if err != nil {
		return DynamicRouteVersion{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists int
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM dynamic_routes WHERE id = ?`), id).Scan(&exists); err != nil {
			return DynamicRouteVersion{}, err
		}
		if exists == 0 {
			return DynamicRouteVersion{}, ErrDynamicRouteNotFound
		}
		return DynamicRouteVersion{}, ErrDynamicRouteConflict
	}
	version := DynamicRouteVersion{RouteID: id, Version: baseVersion + 1, Graph: graph, Note: note, CreatedBy: actor, CreatedAt: now}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO dynamic_route_versions
		(route_id, version, graph_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
		cleanArgs([]any{id, version.Version, graph, note, actor, now})...); err != nil {
		return DynamicRouteVersion{}, err
	}
	if err := tx.Commit(); err != nil {
		return DynamicRouteVersion{}, err
	}
	return version, nil
}

// ListDynamicRouteVersions returns the newest versions first, without their graphs.
func (s *SQLStore) ListDynamicRouteVersions(ctx context.Context, id string, limit int) ([]DynamicRouteVersion, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT route_id, version, note, COALESCE(created_by, ''), created_at
		FROM dynamic_route_versions WHERE route_id = ? ORDER BY version DESC LIMIT ?`), id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DynamicRouteVersion{}
	for rows.Next() {
		var version DynamicRouteVersion
		if err := rows.Scan(&version.RouteID, &version.Version, &version.Note, &version.CreatedBy, &version.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	return out, rows.Err()
}

// GetDynamicRouteVersion returns one version with its graph.
func (s *SQLStore) GetDynamicRouteVersion(ctx context.Context, id string, version int) (DynamicRouteVersion, bool, error) {
	var out DynamicRouteVersion
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT route_id, version, graph_json, note, COALESCE(created_by, ''), created_at
		FROM dynamic_route_versions WHERE route_id = ? AND version = ?`), id, version).
		Scan(&out.RouteID, &out.Version, &out.Graph, &out.Note, &out.CreatedBy, &out.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DynamicRouteVersion{}, false, nil
	}
	if err != nil {
		return DynamicRouteVersion{}, false, err
	}
	return out, true, nil
}

// DeployDynamicRouteVersion makes version the one that serves traffic. Deploying an
// older version is the rollback. expectedDeployed guards against two operators
// deploying different versions from stale screens; pass -1 to skip the check.
func (s *SQLStore) DeployDynamicRouteVersion(ctx context.Context, id string, version, expectedDeployed int, actor string) (DynamicRoute, error) {
	now := formatTime(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DynamicRoute{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var exists int
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM dynamic_route_versions WHERE route_id = ? AND version = ?`), id, version).Scan(&exists); err != nil {
		return DynamicRoute{}, err
	}
	if exists == 0 {
		var routeExists int
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM dynamic_routes WHERE id = ?`), id).Scan(&routeExists); err != nil {
			return DynamicRoute{}, err
		}
		if routeExists == 0 {
			return DynamicRoute{}, ErrDynamicRouteNotFound
		}
		return DynamicRoute{}, ErrDynamicRouteVersionMissing
	}
	query := `UPDATE dynamic_routes SET deployed_version = ?, deployed_at = ?, deployed_by = ?, updated_by = ?, updated_at = ? WHERE id = ?`
	args := []any{version, now, actor, actor, now, id}
	if expectedDeployed >= 0 {
		query += ` AND deployed_version = ?`
		args = append(args, expectedDeployed)
	}
	res, err := tx.ExecContext(ctx, s.bind(query), cleanArgs(args)...)
	if err != nil {
		return DynamicRoute{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return DynamicRoute{}, ErrDynamicRouteConflict
	}
	route, err := scanDynamicRoute(tx.QueryRowContext(ctx, s.bind(`SELECT `+dynamicRouteColumns+` FROM dynamic_routes WHERE id = ?`), id).Scan)
	if err != nil {
		return DynamicRoute{}, err
	}
	if err := tx.Commit(); err != nil {
		return DynamicRoute{}, err
	}
	return route, nil
}

// ListDeployedDynamicRoutes returns every route that has a deployed version, with that
// version's graph. Disabled routes are included so the caller can tell "turned off"
// from "does not exist".
func (s *SQLStore) ListDeployedDynamicRoutes(ctx context.Context) ([]DeployedDynamicRoute, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id, r.name, r.description, r.enabled, r.deployed_version, r.latest_version,
		COALESCE(r.deployed_at, ''), COALESCE(r.deployed_by, ''), COALESCE(r.created_by, ''), COALESCE(r.updated_by, ''), r.created_at, r.updated_at,
		v.graph_json
		FROM dynamic_routes r
		JOIN dynamic_route_versions v ON v.route_id = r.id AND v.version = r.deployed_version
		WHERE r.deployed_version > 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeployedDynamicRoute{}
	for rows.Next() {
		var deployed DeployedDynamicRoute
		var enabled int
		route := &deployed.Route
		if err := rows.Scan(&route.ID, &route.Name, &route.Description, &enabled, &route.DeployedVersion, &route.LatestVersion,
			&route.DeployedAt, &route.DeployedBy, &route.CreatedBy, &route.UpdatedBy, &route.CreatedAt, &route.UpdatedAt,
			&deployed.Graph); err != nil {
			return nil, err
		}
		route.Enabled = enabled != 0
		out = append(out, deployed)
	}
	return out, rows.Err()
}

// ConsumeDynamicRouteCount takes one request from a count limit. It succeeds only
// while the window's count is below limit, and the check and the increment are a
// single conditional UPDATE, so concurrent requests on several gateway replicas
// cannot all slip through on the same last slot.
func (s *SQLStore) ConsumeDynamicRouteCount(ctx context.Context, routeID, elementID, scopeKey string, windowStart, windowEnd, limit int64) (bool, error) {
	now := formatTime(time.Now())
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO dynamic_route_counters
		(route_id, element_id, scope_key, window_start, window_end, request_count, cost_krw, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, 0, ?)
		ON CONFLICT(route_id, element_id, scope_key, window_start) DO NOTHING`),
		cleanArgs([]any{routeID, elementID, scopeKey, windowStart, windowEnd, now})...); err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE dynamic_route_counters SET request_count = request_count + 1, updated_at = ?
		WHERE route_id = ? AND element_id = ? AND scope_key = ? AND window_start = ? AND request_count < ?`),
		cleanArgs([]any{now, routeID, elementID, scopeKey, windowStart, limit})...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// DynamicRouteCostUsed returns what a cost limit has already spent in the window.
func (s *SQLStore) DynamicRouteCostUsed(ctx context.Context, routeID, elementID, scopeKey string, windowStart int64) (float64, error) {
	var cost float64
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT cost_krw FROM dynamic_route_counters
		WHERE route_id = ? AND element_id = ? AND scope_key = ? AND window_start = ?`),
		cleanArgs([]any{routeID, elementID, scopeKey, windowStart})...).Scan(&cost)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return cost, err
}

// AddDynamicRouteCost charges a finished request's cost to a cost limit. The cost is
// only known after the response, so a burst can overshoot the limit by the requests
// already in flight; the next request after them is the one that falls back.
func (s *SQLStore) AddDynamicRouteCost(ctx context.Context, routeID, elementID, scopeKey string, windowStart, windowEnd int64, costKRW float64) error {
	if costKRW <= 0 {
		return nil
	}
	now := formatTime(time.Now())
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO dynamic_route_counters
		(route_id, element_id, scope_key, window_start, window_end, request_count, cost_krw, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?)
		ON CONFLICT(route_id, element_id, scope_key, window_start)
		DO UPDATE SET cost_krw = dynamic_route_counters.cost_krw + excluded.cost_krw, updated_at = excluded.updated_at`),
		cleanArgs([]any{routeID, elementID, scopeKey, windowStart, windowEnd, costKRW, now})...)
	return err
}

// ListDynamicRouteCounters returns the counters of a route whose window is still
// open at now (unix seconds), busiest first, for the console's usage view.
func (s *SQLStore) ListDynamicRouteCounters(ctx context.Context, routeID string, now int64, limit int) ([]DynamicRouteCounter, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT route_id, element_id, scope_key, window_start, window_end, request_count, cost_krw, updated_at
		FROM dynamic_route_counters WHERE route_id = ? AND window_end > ?
		ORDER BY request_count DESC, cost_krw DESC LIMIT ?`), routeID, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DynamicRouteCounter{}
	for rows.Next() {
		var counter DynamicRouteCounter
		if err := rows.Scan(&counter.RouteID, &counter.ElementID, &counter.ScopeKey, &counter.WindowStart, &counter.WindowEnd,
			&counter.RequestCount, &counter.CostKRW, &counter.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, counter)
	}
	return out, rows.Err()
}

// PurgeDynamicRouteCounters drops windows that closed before cutoff (unix seconds).
// A closed window is never read again: the next request opens a new one.
func (s *SQLStore) PurgeDynamicRouteCounters(ctx context.Context, cutoff int64) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM dynamic_route_counters WHERE window_end < ?`), cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLStore) insertDynamicRouteRequest(ctx context.Context, tx *sql.Tx, req RequestLog, record DynamicRouteRequest) error {
	if record.RequestID == "" {
		record.RequestID = req.ID
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = req.CreatedAt
	}
	if record.StatusCode == 0 {
		record.StatusCode = req.StatusCode
	}
	if record.LatencyMS == 0 {
		record.LatencyMS = req.LatencyMS
	}
	_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO dynamic_route_requests
		(request_id, route_id, route_name, version, path_json, metadata_json, final_element_id, final_model, final_provider,
		 fallbacks, attempts, outcome, status_code, latency_ms, cost_krw, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(request_id) DO NOTHING`),
		cleanArgs([]any{record.RequestID, record.RouteID, record.RouteName, record.Version, record.PathJSON, record.MetadataJSON,
			record.FinalElementID, record.FinalModel, record.FinalProvider, record.Fallbacks, record.Attempts, record.Outcome,
			record.StatusCode, record.LatencyMS, record.CostKRW, formatTime(record.CreatedAt)})...)
	return err
}

// ListDynamicRouteRequests returns the newest requests a route served.
func (s *SQLStore) ListDynamicRouteRequests(ctx context.Context, routeID string, limit int) ([]DynamicRouteRequest, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT request_id, route_id, route_name, version, path_json, metadata_json,
		COALESCE(final_element_id, ''), COALESCE(final_model, ''), COALESCE(final_provider, ''), fallbacks, attempts, outcome,
		status_code, latency_ms, cost_krw, created_at
		FROM dynamic_route_requests WHERE route_id = ? ORDER BY created_at DESC LIMIT ?`), routeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DynamicRouteRequest{}
	for rows.Next() {
		var record DynamicRouteRequest
		var created string
		if err := rows.Scan(&record.RequestID, &record.RouteID, &record.RouteName, &record.Version, &record.PathJSON, &record.MetadataJSON,
			&record.FinalElementID, &record.FinalModel, &record.FinalProvider, &record.Fallbacks, &record.Attempts, &record.Outcome,
			&record.StatusCode, &record.LatencyMS, &record.CostKRW, &created); err != nil {
			return nil, err
		}
		record.CreatedAt, _ = parseStoredTime(created)
		out = append(out, record)
	}
	return out, rows.Err()
}

// DynamicRouteTraffic aggregates a route's requests since a time by version, final
// element and outcome.
func (s *SQLStore) DynamicRouteTraffic(ctx context.Context, routeID string, since time.Time) ([]DynamicRouteTrafficRow, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT version, COALESCE(final_element_id, ''), COALESCE(final_model, ''), outcome,
		COUNT(*), COALESCE(SUM(fallbacks), 0), COALESCE(AVG(latency_ms), 0), COALESCE(SUM(cost_krw), 0)
		FROM dynamic_route_requests WHERE route_id = ? AND created_at >= ?
		GROUP BY version, final_element_id, final_model, outcome
		ORDER BY COUNT(*) DESC LIMIT 200`), routeID, formatTime(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DynamicRouteTrafficRow{}
	for rows.Next() {
		var row DynamicRouteTrafficRow
		if err := rows.Scan(&row.Version, &row.FinalElementID, &row.FinalModel, &row.Outcome,
			&row.Requests, &row.Fallbacks, &row.AvgLatencyMS, &row.CostKRW); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// DynamicRouteTotals is a route's request count since a time, for the route list.
type DynamicRouteTotals struct {
	Requests  int64 `json:"requests"`
	Failures  int64 `json:"failures"`
	Fallbacks int64 `json:"fallbacks"`
}

// DynamicRouteTrafficTotals counts every route's requests since a time in one query.
func (s *SQLStore) DynamicRouteTrafficTotals(ctx context.Context, since time.Time) (map[string]DynamicRouteTotals, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT route_id, COUNT(*),
		COALESCE(SUM(CASE WHEN outcome <> 'success' OR status_code >= 400 THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN fallbacks > 0 THEN 1 ELSE 0 END), 0)
		FROM dynamic_route_requests WHERE created_at >= ? GROUP BY route_id`), formatTime(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]DynamicRouteTotals{}
	for rows.Next() {
		var routeID string
		var totals DynamicRouteTotals
		if err := rows.Scan(&routeID, &totals.Requests, &totals.Failures, &totals.Fallbacks); err != nil {
			return nil, err
		}
		out[routeID] = totals
	}
	return out, rows.Err()
}
