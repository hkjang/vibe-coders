import { z } from "zod";

import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminRoutingDomainDecisionsData,
  RoutingDomainDecision as GeneratedRoutingDomainDecision,
  RoutingDomainSignal as GeneratedRoutingDomainSignal,
} from "@/shared/api/generated";

export type RoutingDomainDecision = Omit<
  GeneratedRoutingDomainDecision,
  "query_hash" | "user_id" | "team_id"
>;
export type RoutingDomainSignal = GeneratedRoutingDomainSignal;
export interface RoutingDomainDecisionReport {
  decisions: RoutingDomainDecision[];
  signals: Record<string, RoutingDomainSignal[] | null>;
}

const measurement = z.number().finite();
// The existing read API has no nonnegative/range constraint. Preserve signed
// counts and scores, while rejecting integers JavaScript cannot represent.
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const routingDomainDecisionSchema = z.object({
  id: z.string(),
  request_id: z.string(),
  route: z.string(),
  confidence: measurement,
  tool_names: z.array(z.string()),
  evidence_score: measurement,
  evidence_count: integer,
  fallback_used: z.boolean(),
  blocked_by_governance: z.boolean(),
  reason: z.string(),
  created_at: z.string(),
}) satisfies z.ZodType<RoutingDomainDecision>;

export const routingDomainSignalSchema = z.object({
  id: z.string(),
  decision_id: z.string(),
  source: z.string(),
  route: z.string(),
  score: measurement,
  reason: z.string(),
  created_at: z.string(),
}) satisfies z.ZodType<RoutingDomainSignal>;

const signalListSchema = z.array(routingDomainSignalSchema).nullable();
// Do not traverse or retain entries for decisions outside the returned list.
// Own-key lookup also supports literal IDs such as "__proto__" and "constructor".
const signalMapSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

export const routingDomainDecisionReportSchema = z
  .object({
    decisions: z
      .array(routingDomainDecisionSchema)
      .max(200)
      .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, {
        message: "도메인 결정 ID가 중복되었습니다.",
      }),
    signals: signalMapSchema,
  })
  .transform((report, context): RoutingDomainDecisionReport => {
    const entries: [string, RoutingDomainSignal[] | null][] = [];
    const signalIDs = new Set<string>();
    for (const decision of report.decisions) {
      const own = Object.hasOwn(report.signals, decision.id);
      const parsed = signalListSchema.safeParse(own ? report.signals[decision.id] : undefined);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["signals"],
          message: "결정 근거 응답을 확인할 수 없습니다.",
        });
        return z.NEVER;
      }
      for (const signal of parsed.data ?? []) {
        if (signal.decision_id !== decision.id || signalIDs.has(signal.id)) {
          context.addIssue({
            code: "custom",
            path: ["signals"],
            message: "결정과 근거의 연결을 확인할 수 없습니다.",
          });
          return z.NEVER;
        }
        signalIDs.add(signal.id);
      }
      entries.push([decision.id, parsed.data]);
    }
    // [] records a successful empty read; null records an unconfirmed read.
    // Neither a populated array nor [] proves complete/atomic signal collection.
    return { decisions: report.decisions, signals: Object.fromEntries(entries) };
  }) satisfies z.ZodType<RoutingDomainDecisionReport>;

export const routingDomainDecisionsQuerySchema = z
  .object({
    window: z.enum(["24h", "7d", "30d", "90d"]),
    route: z.string().optional(),
    request_id: z.string().optional(),
    limit: z.literal(50),
  })
  .strict();
export type RoutingDomainDecisionsQuery = z.input<typeof routingDomainDecisionsQuerySchema>;

export const routingDomainDecisionEndpoints = {
  report: operation<
    WithQuery<GetAdminRoutingDomainDecisionsData, RoutingDomainDecisionsQuery>,
    RoutingDomainDecisionReport
  >()(
    "GET",
    "/admin/routing/domain-decisions",
    routingDomainDecisionReportSchema,
    routingDomainDecisionsQuerySchema,
  ),
} as const;
