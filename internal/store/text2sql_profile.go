package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Text2SQLProfile is a runtime-managed virtual-model mapping. It overrides the
// env-configured defaults and lets operators add brand-new virtual models (e.g.
// vibe/text2sql-finance) bound to a specific upstream model, mode, schema, and
// execution database connection.
type Text2SQLProfile struct {
	VirtualModel     string `json:"virtual_model"`
	Mode             string `json:"mode"` // preview | execute
	UpstreamModel    string `json:"upstream_model"`
	SummaryModel     string `json:"summary_model"`
	SchemaName       string `json:"schema_name"`
	ExecConnectionID string `json:"exec_connection_id"` // "" / "default" = env TEXT2SQL_EXEC_DSN
	Enabled          bool   `json:"enabled"`
	UpdatedAt        string `json:"updated_at"`
}

func (s *SQLStore) ListText2SQLProfiles(ctx context.Context) ([]Text2SQLProfile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT virtual_model, mode, COALESCE(upstream_model,''), COALESCE(summary_model,''),
		        COALESCE(schema_name,''), COALESCE(exec_connection_id,''), enabled, updated_at
		 FROM text2sql_profiles ORDER BY virtual_model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLProfile{}
	for rows.Next() {
		var p Text2SQLProfile
		var enabled int
		if err := rows.Scan(&p.VirtualModel, &p.Mode, &p.UpstreamModel, &p.SummaryModel,
			&p.SchemaName, &p.ExecConnectionID, &enabled, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Enabled = enabled == 1
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetText2SQLProfile(ctx context.Context, virtualModel string) (Text2SQLProfile, bool, error) {
	var p Text2SQLProfile
	var enabled int
	err := s.db.QueryRowContext(ctx, s.bind(
		`SELECT virtual_model, mode, COALESCE(upstream_model,''), COALESCE(summary_model,''),
		        COALESCE(schema_name,''), COALESCE(exec_connection_id,''), enabled, updated_at
		 FROM text2sql_profiles WHERE virtual_model = ?`), virtualModel).
		Scan(&p.VirtualModel, &p.Mode, &p.UpstreamModel, &p.SummaryModel,
			&p.SchemaName, &p.ExecConnectionID, &enabled, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Text2SQLProfile{}, false, nil
	}
	if err != nil {
		return Text2SQLProfile{}, false, err
	}
	p.Enabled = enabled == 1
	return p, true, nil
}

func (s *SQLStore) UpsertText2SQLProfile(ctx context.Context, p Text2SQLProfile) error {
	if p.Mode == "" {
		p.Mode = "preview"
	}
	enabled := 1
	if !p.Enabled {
		enabled = 0
	}
	_, err := s.db.ExecContext(ctx, s.bind(
		`INSERT INTO text2sql_profiles
		 (virtual_model, mode, upstream_model, summary_model, schema_name, exec_connection_id, enabled, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(virtual_model) DO UPDATE SET mode=excluded.mode, upstream_model=excluded.upstream_model,
		 summary_model=excluded.summary_model, schema_name=excluded.schema_name,
		 exec_connection_id=excluded.exec_connection_id, enabled=excluded.enabled, updated_at=excluded.updated_at`),
		p.VirtualModel, p.Mode, p.UpstreamModel, p.SummaryModel,
		p.SchemaName, p.ExecConnectionID, enabled, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLProfile(ctx context.Context, virtualModel string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_profiles WHERE virtual_model = ?`), virtualModel)
	return err
}
