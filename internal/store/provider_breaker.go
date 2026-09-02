package store

import (
	"context"
	"strings"
	"time"
)

// Shared circuit-breaker state.
//
// Breaker state is per process: each gateway instance discovers a dead provider on its
// own, which costs it up to BreakerThreshold failed requests that another instance has
// already paid for. Publishing transitions through the shared database lets the others
// skip that provider without rediscovering it.
//
// Only transitions are written — opening and closing — so this adds no per-request
// write. Rows are advisory: consumers must expire them, because an instance that dies
// while a breaker is open would otherwise leave a provider excluded forever.
type ProviderBreakerState struct {
	Provider string    `json:"provider"`
	Phase    string    `json:"phase"`
	Reason   string    `json:"reason"`
	Instance string    `json:"instance"`
	OpenedAt time.Time `json:"opened_at"`
	// UpdatedAt is when the publishing instance last confirmed this state. A consumer
	// uses it to ignore rows left behind by an instance that has since gone away.
	UpdatedAt time.Time `json:"updated_at"`
}

// PublishProviderBreaker records a breaker transition for other instances to observe.
func (s *SQLStore) PublishProviderBreaker(ctx context.Context, state ProviderBreakerState) error {
	if strings.TrimSpace(state.Provider) == "" {
		return nil
	}
	now := time.Now().UTC()
	if state.UpdatedAt.IsZero() {
		state.UpdatedAt = now
	}
	if state.OpenedAt.IsZero() {
		state.OpenedAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO provider_breaker_state
			(provider, phase, reason, instance, opened_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider) DO UPDATE SET
			phase = excluded.phase,
			reason = excluded.reason,
			instance = excluded.instance,
			opened_at = excluded.opened_at,
			updated_at = excluded.updated_at`),
		state.Provider, state.Phase, state.Reason, state.Instance,
		formatTime(state.OpenedAt), formatTime(state.UpdatedAt))
	return err
}

// ClearProviderBreaker removes a provider's shared row, which is how a recovery is
// announced: the absence of a row means nobody currently considers it broken.
func (s *SQLStore) ClearProviderBreaker(ctx context.Context, provider string) error {
	if strings.TrimSpace(provider) == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM provider_breaker_state WHERE provider = ?`), provider)
	return err
}

// ClearAllProviderBreakers atomically clears the shared breaker registry. A reset-all
// must include rows reported by peers that this process has not adopted locally yet.
func (s *SQLStore) ClearAllProviderBreakers(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM provider_breaker_state`)
	return err
}

// ListOpenProviderBreakers returns providers reported open by any instance since the
// given time. The caller supplies the cutoff so the freshness policy stays with the
// routing layer that knows the cooldown.
func (s *SQLStore) ListOpenProviderBreakers(ctx context.Context, since time.Time) ([]ProviderBreakerState, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT provider, phase, COALESCE(reason, ''), COALESCE(instance, ''), opened_at, updated_at
		FROM provider_breaker_state
		WHERE phase = 'open' AND updated_at >= ?
		ORDER BY provider ASC`), formatTime(since.UTC()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProviderBreakerState{}
	for rows.Next() {
		var st ProviderBreakerState
		var openedAt, updatedAt string
		if err := rows.Scan(&st.Provider, &st.Phase, &st.Reason, &st.Instance, &openedAt, &updatedAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, openedAt); err == nil {
			st.OpenedAt = parsed
		}
		if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
			st.UpdatedAt = parsed
		}
		out = append(out, st)
	}
	return out, rows.Err()
}
