package store

import (
	"context"
	"time"
)

var budgetKST = time.FixedZone("KST", 9*3600)

// kstMonthBounds returns the start of the current month and the number of days in it,
// in Asia/Seoul (the same zone quotas reset on).
func kstMonthBounds(now time.Time) (time.Time, float64) {
	local := now.In(budgetKST)
	start := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, budgetKST)
	end := start.AddDate(0, 1, 0)
	return start, end.Sub(start).Hours() / 24
}

func (s *SQLStore) ListBudgets(ctx context.Context) ([]Budget, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, scope, scope_value, monthly_krw, COALESCE(note, ''), created_at
		FROM budgets ORDER BY scope, scope_value`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Budget{}
	for rows.Next() {
		var b Budget
		var createdAt string
		if err := rows.Scan(&b.ID, &b.Scope, &b.ScopeValue, &b.MonthlyKRW, &b.Note, &createdAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			b.CreatedAt = parsed
		}
		result = append(result, b)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertBudget(ctx context.Context, b Budget) error {
	if b.CreatedAt.IsZero() {
		b.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO budgets (id, scope, scope_value, monthly_krw, note, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, scope_value = excluded.scope_value, monthly_krw = excluded.monthly_krw, note = excluded.note`),
		b.ID, b.Scope, b.ScopeValue, b.MonthlyKRW, b.Note, formatTime(b.CreatedAt))
	return err
}

func (s *SQLStore) DeleteBudget(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM budgets WHERE id = ?`), id)
	return err
}

// budgetStatus computes burn-down / forecast for one budget at time `now`.
func (s *SQLStore) budgetStatus(ctx context.Context, b Budget, now time.Time) (BudgetStatus, error) {
	start, daysInMonth := kstMonthBounds(now)
	_, spent, _, err := s.UsageSince(ctx, UsageFilter{Scope: b.Scope, ScopeValue: b.ScopeValue, Since: start})
	if err != nil {
		return BudgetStatus{}, err
	}
	elapsed := now.Sub(start).Hours() / 24
	if elapsed < 0.02 { // avoid divide-by-zero at the very start of the month
		elapsed = 0.02
	}
	st := BudgetStatus{
		Budget:      b,
		SpentKRW:    spent,
		DaysElapsed: elapsed,
		DaysInMonth: daysInMonth,
	}
	runRate := spent / elapsed // KRW/day
	st.ProjectedKRW = runRate * daysInMonth
	if b.MonthlyKRW > 0 {
		st.BurnRatio = spent / b.MonthlyKRW
		st.ProjectedRatio = st.ProjectedKRW / b.MonthlyKRW
	}
	st.OnTrack = st.ProjectedKRW <= b.MonthlyKRW || b.MonthlyKRW <= 0
	// exhaustion date: when cumulative spend at the current run-rate hits the budget.
	if runRate > 0 && b.MonthlyKRW > 0 {
		daysToExhaust := b.MonthlyKRW / runRate
		exhaust := start.Add(time.Duration(daysToExhaust * 24 * float64(time.Hour)))
		if !exhaust.After(start.AddDate(0, 1, 0)) {
			st.ExhaustionDate = exhaust.In(budgetKST).Format("2006-01-02")
		}
	}
	return st, nil
}

// BudgetStatuses returns the forecast for every configured budget.
func (s *SQLStore) BudgetStatuses(ctx context.Context, now time.Time) ([]BudgetStatus, error) {
	budgets, err := s.ListBudgets(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]BudgetStatus, 0, len(budgets))
	for _, b := range budgets {
		st, err := s.budgetStatus(ctx, b, now)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// MaxBudgetProjectedRatio returns the largest projected_ratio across budgets, for alerting.
func (s *SQLStore) MaxBudgetProjectedRatio(ctx context.Context, now time.Time) (float64, error) {
	statuses, err := s.BudgetStatuses(ctx, now)
	if err != nil {
		return 0, err
	}
	var max float64
	for _, st := range statuses {
		if st.ProjectedRatio > max {
			max = st.ProjectedRatio
		}
	}
	return max, nil
}
