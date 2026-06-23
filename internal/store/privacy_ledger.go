package store

import (
	"context"
	"fmt"
	"time"
)

// PrivacyLedgerRow is one dimension value's privacy/egress accounting for a window: how much
// sensitive data was detected/masked/blocked, and how many requests + tokens were transmitted to
// an (external) upstream provider. For PIA / internal audit of external-model data flow.
type PrivacyLedgerRow struct {
	DimValue       string `json:"dim_value"`
	Detections     int64  `json:"detections"`      // secret_events action=detect
	Masked         int64  `json:"masked"`          // action=mask
	Blocked        int64  `json:"blocked"`         // action=block
	EgressRequests int64  `json:"egress_requests"` // successful requests sent to a provider
	EgressTokens   int64  `json:"egress_tokens"`
}

// privacyLedgerDims maps a ledger dimension to (secret-event expr, egress expr, extra egress join).
var privacyLedgerDims = map[string]struct {
	secretExpr string
	egressExpr string
	egressJoin string
}{
	"team":     {"COALESCE(NULLIF(e.team_id, ''), '(none)')", "COALESCE(NULLIF(k.team, ''), '(none)')", "LEFT JOIN api_keys k ON k.id = r.api_key_id"},
	"model":    {"COALESCE(NULLIF(r.model, ''), '(unknown)')", "COALESCE(NULLIF(r.model, ''), '(unknown)')", ""},
	"provider": {"COALESCE(NULLIF(r.provider, ''), '(unknown)')", "COALESCE(NULLIF(r.provider, ''), '(unknown)')", ""},
}

// PrivacyLedger aggregates sensitive-data handling and external egress by dimension since a
// cutoff. dimension is one of team|model|provider.
func (s *SQLStore) PrivacyLedger(ctx context.Context, dimension string, since time.Time) ([]PrivacyLedgerRow, error) {
	d, ok := privacyLedgerDims[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported privacy-ledger dimension %q", dimension)
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)
	rows := map[string]*PrivacyLedgerRow{}
	get := func(k string) *PrivacyLedgerRow {
		if rows[k] == nil {
			rows[k] = &PrivacyLedgerRow{DimValue: k}
		}
		return rows[k]
	}

	// Sensitive-data handling from secret_events.
	secRows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT %s, e.action, COUNT(*)
		FROM secret_events e
		LEFT JOIN request_logs r ON e.request_id = r.id
		WHERE e.created_at >= ?
		GROUP BY %s, e.action`, d.secretExpr, d.secretExpr)), sinceStr)
	if err != nil {
		return nil, err
	}
	for secRows.Next() {
		var dim, action string
		var n int64
		if err := secRows.Scan(&dim, &action, &n); err != nil {
			secRows.Close()
			return nil, err
		}
		row := get(dim)
		switch action {
		case "detect":
			row.Detections += n
		case "mask":
			row.Masked += n
		case "block":
			row.Blocked += n
		}
	}
	secRows.Close()

	// External egress from successful requests that reached a provider.
	egRows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT %s, COUNT(r.id), COALESCE(SUM(t.total_tokens), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		%s
		WHERE r.created_at >= ? AND r.status_code < 400 AND COALESCE(r.provider, '') <> ''
		GROUP BY %s`, d.egressExpr, d.egressJoin, d.egressExpr)), sinceStr)
	if err != nil {
		return nil, err
	}
	for egRows.Next() {
		var dim string
		var reqs, toks int64
		if err := egRows.Scan(&dim, &reqs, &toks); err != nil {
			egRows.Close()
			return nil, err
		}
		row := get(dim)
		row.EgressRequests += reqs
		row.EgressTokens += toks
	}
	egRows.Close()

	out := make([]PrivacyLedgerRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	return out, nil
}
