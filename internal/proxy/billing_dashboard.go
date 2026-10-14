package proxy

import (
	"context"
	"time"

	"vibe-coders/internal/store"
)

// A read-only projection of existing store operations; no second accounting model.
type billingDashboardStore interface {
	UsageSince(context.Context, store.UsageFilter) (int64, float64, int64, error)
	CostAllocation(context.Context, string, time.Time, int) ([]store.CostAllocationRow, error)
	BudgetStatuses(context.Context, time.Time) ([]store.BudgetStatus, error)
	ModelMigrationAdvice(context.Context, time.Time, int, int) ([]store.ModelMigrationAdvice, error)
}

type billingDashboard struct {
	Since               string                       `json:"since"`
	TotalCostKRW        float64                      `json:"total_cost_krw"`
	TotalRequests       int64                        `json:"total_requests"`
	TotalsScope         string                       `json:"totals_scope"`
	ByCostCenter        []store.CostAllocationRow    `json:"by_cost_center"`
	ByModel             []store.CostAllocationRow    `json:"by_model"`
	Budgets             []store.BudgetStatus         `json:"budgets"`
	MigrationCandidates []store.ModelMigrationAdvice `json:"migration_candidates"`
	EstimatedSavingsKRW float64                      `json:"estimated_savings_krw"`
	UnavailableSections []string                     `json:"unavailable_sections"`
}

func readBillingDashboard(ctx context.Context, db billingDashboardStore, since, now time.Time) (billingDashboard, error) {
	requests, cost, _, err := db.UsageSince(ctx, store.UsageFilter{Scope: "global", Since: since})
	if err != nil {
		return billingDashboard{}, err
	}
	report := billingDashboard{
		Since: since.UTC().Format(time.RFC3339), TotalRequests: requests, TotalCostKRW: cost,
		TotalsScope: "all_retained_requests", UnavailableSections: []string{},
	}
	// Lists remain bounded and independent. Discard partial rows on any read error.
	report.ByCostCenter, err = db.CostAllocation(ctx, "cost_center", since, 20)
	if err != nil {
		report.ByCostCenter = nil
		report.UnavailableSections = append(report.UnavailableSections, "by_cost_center")
	}
	report.ByModel, err = db.CostAllocation(ctx, "model", since, 20)
	if err != nil {
		report.ByModel = nil
		report.UnavailableSections = append(report.UnavailableSections, "by_model")
	}
	report.Budgets, err = db.BudgetStatuses(ctx, now)
	if err != nil {
		report.Budgets = nil
		report.UnavailableSections = append(report.UnavailableSections, "budgets")
	}
	report.MigrationCandidates, err = db.ModelMigrationAdvice(ctx, since, 10, 20)
	if err != nil {
		report.MigrationCandidates = nil
		report.UnavailableSections = append(report.UnavailableSections, "migration_candidates")
	}
	for _, candidate := range report.MigrationCandidates {
		report.EstimatedSavingsKRW += candidate.EstimatedSavingsKRW
	}
	return report, nil
}
