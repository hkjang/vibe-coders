package store

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// CarbonCoeff parameterizes the energy/emissions estimate. Mirrors config.CarbonConfig;
// the proxy translates config into this value so the store stays config-agnostic.
type CarbonCoeff struct {
	DefaultWhPer1K  float64            // watt-hours per 1,000 tokens (default)
	PerModelWhPer1K map[string]float64 // per-model overrides (model → Wh/1K)
	PUE             float64            // datacenter Power Usage Effectiveness multiplier
	GridIntensityG  float64            // grid carbon intensity, gCO2e per kWh
}

// whPer1K returns the per-1K-token energy coefficient for a model, falling back to the
// default when the model has no explicit override.
func (c CarbonCoeff) whPer1K(model string) float64 {
	if c.PerModelWhPer1K != nil {
		if v, ok := c.PerModelWhPer1K[model]; ok {
			return v
		}
	}
	return c.DefaultWhPer1K
}

// CarbonScore is the estimated energy and operational carbon attributable to a subject's
// token throughput over a window. Read-only operational signal — nothing enforces on it.
type CarbonScore struct {
	Subject     string  `json:"subject"`
	Requests    int64   `json:"requests"`
	TotalTokens int64   `json:"total_tokens"`
	EnergyWh    float64 `json:"energy_wh"`
	CO2eGrams   float64 `json:"co2e_grams"`
	WhPerReq    float64 `json:"wh_per_request"`
}

// CarbonScores estimates per-subject energy (Wh) and emissions (gCO2e) from logged token
// usage over the window. It groups by subject AND model so per-model energy coefficients
// apply, folds models into each subject, then sorts by emissions descending. The estimate
// is coarse and configurable — useful for comparing subjects, not as an audited figure.
func (s *SQLStore) CarbonScores(ctx context.Context, dimension string, since time.Time, limit int, coeff CarbonCoeff) ([]CarbonScore, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported carbon-score dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	pue := coeff.PUE
	if pue <= 0 {
		pue = 1
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COALESCE(r.model, ''),
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)'), r.model
	`, col, col))

	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	agg := map[string]*CarbonScore{}
	order := []string{}
	for rows.Next() {
		var subject, model string
		var reqs, tokens int64
		if err := rows.Scan(&subject, &model, &reqs, &tokens); err != nil {
			return nil, err
		}
		cs := agg[subject]
		if cs == nil {
			cs = &CarbonScore{Subject: subject}
			agg[subject] = cs
			order = append(order, subject)
		}
		cs.Requests += reqs
		cs.TotalTokens += tokens
		cs.EnergyWh += float64(tokens) / 1000 * coeff.whPer1K(model) * pue
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]CarbonScore, 0, len(order))
	for _, subject := range order {
		cs := agg[subject]
		cs.CO2eGrams = cs.EnergyWh / 1000 * coeff.GridIntensityG
		if cs.Requests > 0 {
			cs.WhPerReq = cs.EnergyWh / float64(cs.Requests)
		}
		out = append(out, *cs)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CO2eGrams != out[j].CO2eGrams {
			return out[i].CO2eGrams > out[j].CO2eGrams
		}
		return out[i].TotalTokens > out[j].TotalTokens
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
