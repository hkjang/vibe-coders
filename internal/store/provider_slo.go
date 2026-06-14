package store

import (
	"context"
	"time"
)

// ProviderSLO is an operator-defined service-level objective for one upstream
// provider. Targets are upper/lower bounds depending on the metric:
//   - AvailabilityTarget: minimum acceptable availability (0-1), e.g. 0.99
//   - P95LatencyTargetMS: maximum acceptable P95 latency in ms
//   - ErrorRateTarget:    maximum acceptable error rate (0-1)
//   - FallbackRateTarget: maximum acceptable fallback rate (0-1)
//
// A zero target means "not enforced" for that metric.
type ProviderSLO struct {
	Provider           string  `json:"provider"`
	AvailabilityTarget float64 `json:"availability_target"`
	P95LatencyTargetMS int64   `json:"p95_latency_target_ms"`
	ErrorRateTarget    float64 `json:"error_rate_target"`
	FallbackRateTarget float64 `json:"fallback_rate_target"`
	Enabled            bool    `json:"enabled"`
	Note               string  `json:"note"`
	UpdatedAt          string  `json:"updated_at"`
}

func (s *SQLStore) ListProviderSLOs(ctx context.Context) ([]ProviderSLO, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT provider, availability_target, p95_latency_target_ms, error_rate_target, fallback_rate_target, enabled, COALESCE(note, ''), updated_at
		FROM provider_slos ORDER BY provider`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProviderSLO{}
	for rows.Next() {
		var slo ProviderSLO
		var enabled int
		if err := rows.Scan(&slo.Provider, &slo.AvailabilityTarget, &slo.P95LatencyTargetMS, &slo.ErrorRateTarget, &slo.FallbackRateTarget, &enabled, &slo.Note, &slo.UpdatedAt); err != nil {
			return nil, err
		}
		slo.Enabled = enabled == 1
		out = append(out, slo)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertProviderSLO(ctx context.Context, slo ProviderSLO) error {
	enabled := 0
	if slo.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO provider_slos
		(provider, availability_target, p95_latency_target_ms, error_rate_target, fallback_rate_target, enabled, note, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider) DO UPDATE SET availability_target = excluded.availability_target,
			p95_latency_target_ms = excluded.p95_latency_target_ms, error_rate_target = excluded.error_rate_target,
			fallback_rate_target = excluded.fallback_rate_target, enabled = excluded.enabled, note = excluded.note,
			updated_at = excluded.updated_at`),
		slo.Provider, slo.AvailabilityTarget, slo.P95LatencyTargetMS, slo.ErrorRateTarget, slo.FallbackRateTarget,
		enabled, slo.Note, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteProviderSLO(ctx context.Context, provider string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM provider_slos WHERE provider = ?`), provider)
	return err
}
