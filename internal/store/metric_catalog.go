package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// MetricCatalogEntry is a curated, named DW metric: a documented ClickHouse query template with
// its dimensions, owner, sensitivity, and enablement — so operators read standard metrics
// instead of re-deriving ad-hoc queries.
type MetricCatalogEntry struct {
	ID            string   `json:"id"`
	MetricKey     string   `json:"metric_key"`
	NameKO        string   `json:"name_ko"`
	Description   string   `json:"description"`
	QueryTemplate string   `json:"query_template"`
	Dimensions    []string `json:"dimensions"`
	Owner         string   `json:"owner"`
	Sensitivity   string   `json:"sensitivity"` // public | internal | restricted
	Enabled       bool     `json:"enabled"`
	Version       int      `json:"version"`
	UpdatedBy     string   `json:"updated_by"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

func metricDimsJoin(d []string) string { return strings.Join(d, ",") }
func metricDimsSplit(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// UpsertMetricCatalog inserts or updates a metric by metric_key, bumping its version on update.
func (s *SQLStore) UpsertMetricCatalog(ctx context.Context, m MetricCatalogEntry) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	enabled := 0
	if m.Enabled {
		enabled = 1
	}
	if m.Sensitivity == "" {
		m.Sensitivity = "internal"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO metric_catalog
		(id, metric_key, name_ko, description, query_template, dimensions, owner, sensitivity, enabled, version, updated_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		ON CONFLICT(metric_key) DO UPDATE SET
			name_ko = excluded.name_ko, description = excluded.description, query_template = excluded.query_template,
			dimensions = excluded.dimensions, owner = excluded.owner, sensitivity = excluded.sensitivity,
			enabled = excluded.enabled, version = metric_catalog.version + 1, updated_by = excluded.updated_by,
			updated_at = excluded.updated_at`),
		m.ID, m.MetricKey, m.NameKO, m.Description, m.QueryTemplate, metricDimsJoin(m.Dimensions), m.Owner, m.Sensitivity, enabled, m.UpdatedBy, now, now)
	return err
}

func scanMetric(sc interface{ Scan(...any) error }) (MetricCatalogEntry, error) {
	var m MetricCatalogEntry
	var dims string
	var enabled int
	if err := sc.Scan(&m.ID, &m.MetricKey, &m.NameKO, &m.Description, &m.QueryTemplate, &dims, &m.Owner, &m.Sensitivity, &enabled, &m.Version, &m.UpdatedBy, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return MetricCatalogEntry{}, err
	}
	m.Dimensions = metricDimsSplit(dims)
	m.Enabled = enabled != 0
	return m, nil
}

func (s *SQLStore) ListMetricCatalog(ctx context.Context) ([]MetricCatalogEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, metric_key, name_ko, description, query_template, dimensions, owner, sensitivity, enabled, version, updated_by, created_at, updated_at
		FROM metric_catalog ORDER BY metric_key ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MetricCatalogEntry{}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetMetricCatalog(ctx context.Context, id string) (MetricCatalogEntry, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, metric_key, name_ko, description, query_template, dimensions, owner, sensitivity, enabled, version, updated_by, created_at, updated_at
		FROM metric_catalog WHERE id = ? OR metric_key = ?`), id, id)
	m, err := scanMetric(row)
	if errors.Is(err, sql.ErrNoRows) {
		return MetricCatalogEntry{}, false, nil
	}
	if err != nil {
		return MetricCatalogEntry{}, false, err
	}
	return m, true, nil
}

func (s *SQLStore) DeleteMetricCatalog(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM metric_catalog WHERE id = ? OR metric_key = ?`), id, id)
	return err
}
