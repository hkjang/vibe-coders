// finops domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import type {
  GetAdminBudgetsAlertsData,
  GetAdminCostAllocationData,
  GetAdminCostAnomaliesData,
  GetAdminCostChargebackPackData,
  GetBillingDashboardData,
} from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import { looseList, looseObject, numberish, orDefault } from "@/shared/api/loose";

const text = orDefault(z.string(), "");
const count = orDefault(numberish, 0);
const flag = orDefault(z.boolean(), false);

/** A legacy list that may arrive as `null` when the store has no rows. */
function list<Shape extends z.ZodRawShape>(shape: Shape) {
  return orDefault(looseList(shape), []);
}

/** `store.CostAllocationRow` (internal/store/reports.go). */
const costRowShape = {
  key: text,
  requests: count,
  tokens: count,
  cost_krw: count,
  error_requests: count,
} as const;

/** `store.BudgetStatus` (internal/store/types.go). */
const budgetStatusShape = {
  budget: looseObject({
    id: text,
    scope: text,
    scope_value: text,
    monthly_krw: count,
    note: text,
    created_at: text,
  }).optional(),
  spent_krw: count,
  burn_ratio: count,
  projected_krw: count,
  projected_ratio: count,
  days_elapsed: count,
  days_in_month: count,
  exhaustion_date: text,
  on_track: flag,
} as const;

/** `store.ModelMigrationAdvice` (internal/store/model_migration.go). */
const migrationCandidateShape = {
  fingerprint: text,
  task_type: text,
  requests: count,
  current_model: text,
  recommended_model: text,
  current_avg_cost_krw: count,
  recommended_avg_cost_krw: count,
  current_success_rate: count,
  recommended_success_rate: count,
  estimated_savings_krw: count,
} as const;

const billingDashboardSchema = looseObject({
  since: text,
  total_cost_krw: count,
  total_requests: count,
  by_cost_center: list(costRowShape),
  by_model: list(costRowShape),
  budgets: list(budgetStatusShape),
  migration_candidates: list(migrationCandidateShape),
  estimated_savings_krw: count,
});

const costAllocationSchema = looseObject({
  dimension: text,
  dimensions: orDefault(z.array(z.string()), []),
  since: text,
  rows: list(costRowShape),
});

const chargebackPackSchema = looseObject({
  month: text,
  period_start: text,
  period_end: text,
  generated_at: text,
  note: text,
  dimensions: list({
    dimension: text,
    rows: list(costRowShape),
    total_cost_krw: count,
    total_requests: count,
  }),
});

const costAnomaliesSchema = looseObject({
  budget_projections: list(budgetStatusShape),
  over_projected: list(budgetStatusShape),
  session_loops: list({
    session_id: text,
    api_key_id: text,
    prompt_fingerprint: text,
    repeats: count,
    cost_krw: count,
    tokens: count,
    first_seen: text,
    last_seen: text,
  }),
  window_since: text,
  projected_ratio: count,
});

const budgetAlertsSchema = looseObject({
  alerts: list({
    scope: text,
    scope_value: text,
    monthly_krw: count,
    spent_krw: count,
    burn_ratio: count,
    projected_ratio: count,
    projected_krw: count,
    exhaustion_date: text,
    severity: text,
  }),
  warn: count,
  critical: count,
  thresholds: looseObject({ warn: count, critical: count }).optional(),
});

const windowQuerySchema = z.object({ window: z.string().optional() }).strict();
const allocationQuerySchema = z
  .object({
    dimension: z.string().optional(),
    window: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const chargebackQuerySchema = z
  .object({ month: z.string().optional(), dimensions: z.string().optional() })
  .strict();
const anomaliesQuerySchema = z
  .object({
    window: z.string().optional(),
    min_repeats: z.number().int().min(1).optional(),
    projected_ratio: z.number().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
// `notify=1` sends Mattermost messages, so the console never passes it.
const budgetAlertsQuerySchema = z
  .object({ warn: z.number().min(0).optional(), critical: z.number().min(0).optional(), all: z.literal(1) })
  .strict();

export type FinopsWindowQuery = z.input<typeof windowQuerySchema>;
export type FinopsAllocationQuery = z.input<typeof allocationQuerySchema>;
export type FinopsChargebackQuery = z.input<typeof chargebackQuerySchema>;
export type FinopsAnomaliesQuery = z.input<typeof anomaliesQuerySchema>;
export type FinopsBudgetAlertsQuery = z.input<typeof budgetAlertsQuerySchema>;

export const finopsEndpoints = {
  billingDashboard: operation<WithQuery<GetBillingDashboardData, FinopsWindowQuery>, unknown>()(
    "GET",
    "/billing/dashboard",
    billingDashboardSchema,
    windowQuerySchema,
  ),
  costAllocation: operation<WithQuery<GetAdminCostAllocationData, FinopsAllocationQuery>, unknown>()(
    "GET",
    "/admin/cost/allocation",
    costAllocationSchema,
    allocationQuerySchema,
  ),
  chargebackPack: operation<WithQuery<GetAdminCostChargebackPackData, FinopsChargebackQuery>, unknown>()(
    "GET",
    "/admin/cost/chargeback-pack",
    chargebackPackSchema,
    chargebackQuerySchema,
  ),
  costAnomalies: operation<WithQuery<GetAdminCostAnomaliesData, FinopsAnomaliesQuery>, unknown>()(
    "GET",
    "/admin/cost/anomalies",
    costAnomaliesSchema,
    anomaliesQuerySchema,
  ),
  budgetAlerts: operation<WithQuery<GetAdminBudgetsAlertsData, FinopsBudgetAlertsQuery>, unknown>()(
    "GET",
    "/admin/budgets/alerts",
    budgetAlertsSchema,
    budgetAlertsQuerySchema,
  ),
} as const;

export type BillingDashboard = z.output<typeof billingDashboardSchema>;
export type CostAllocationReport = z.output<typeof costAllocationSchema>;
export type CostAllocationRow = CostAllocationReport["rows"][number];
export type ChargebackPack = z.output<typeof chargebackPackSchema>;
export type CostAnomalies = z.output<typeof costAnomaliesSchema>;
export type BudgetStatusRow = BillingDashboard["budgets"][number];
export type BudgetAlerts = z.output<typeof budgetAlertsSchema>;
