package store

import (
	"context"
	"time"
)

// InvoiceLineItem is one model's usage line on a cost-center invoice.
type InvoiceLineItem struct {
	Model       string  `json:"model"`
	Requests    int64   `json:"requests"`
	TotalTokens int64   `json:"total_tokens"`
	CostKRW     float64 `json:"cost_krw"`
}

// CostCenterInvoice is a chargeback invoice for one cost center over a period: per-model
// line items plus totals. Read-only; derived from logged usage.
type CostCenterInvoice struct {
	CostCenter    string            `json:"cost_center"`
	Since         string            `json:"since"`
	LineItems     []InvoiceLineItem `json:"line_items"`
	TotalRequests int64             `json:"total_requests"`
	TotalTokens   int64             `json:"total_tokens"`
	TotalCostKRW  float64           `json:"total_cost_krw"`
}

// CostCenterInvoiceData builds a cost-center invoice over the window: usage broken down by
// model (line items, most expensive first) with totals. The costCenter "(unset)" matches
// requests with no cost_center tag.
func (s *SQLStore) CostCenterInvoiceData(ctx context.Context, costCenter string, since time.Time) (CostCenterInvoice, error) {
	inv := CostCenterInvoice{CostCenter: costCenter, Since: since.UTC().Format(time.RFC3339Nano), LineItems: []InvoiceLineItem{}}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND COALESCE(NULLIF(r.cost_center, ''), '(unset)') = ?
		GROUP BY COALESCE(NULLIF(r.model, ''), '(unknown)')
		ORDER BY COALESCE(SUM(t.estimated_cost), 0) DESC`),
		since.UTC().Format(time.RFC3339Nano), costCenter)
	if err != nil {
		return inv, err
	}
	defer rows.Close()
	for rows.Next() {
		var li InvoiceLineItem
		if err := rows.Scan(&li.Model, &li.Requests, &li.TotalTokens, &li.CostKRW); err != nil {
			return inv, err
		}
		inv.LineItems = append(inv.LineItems, li)
		inv.TotalRequests += li.Requests
		inv.TotalTokens += li.TotalTokens
		inv.TotalCostKRW += li.CostKRW
	}
	return inv, rows.Err()
}
