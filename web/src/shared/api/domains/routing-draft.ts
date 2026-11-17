import { z } from "zod";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  PatchAdminRoutingRulesIdData,
  PostAdminRoutingPreviewData,
  RoutingDraftPreviewRequest,
  RoutingDraftPreviewResponse,
  RoutingDraftWriteRequest,
  RoutingDraftWriteResponse,
  RoutingDraftPlan,
} from "@/shared/api/generated";
import { routingEditRuleSchema } from "./routing-edit";

const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const plan = z.object({
  requested_model: z.string(),
  selected_model: z.string(),
  selected_provider: z.string(),
  policy_api_key_id: z.string(),
  complexity: z.object({ score: z.number().int(), tier: z.string() }),
  risk: z.object({ score: z.number().int(), tier: z.string(), categories: z.array(z.string()) }),
  health_score: z.number().int(),
  fallback_plan: z.array(z.string()),
  route_reason: z.string(),
  decision_reason: z.string(),
  would_rewrite: z.boolean(),
}) satisfies z.ZodType<RoutingDraftPlan>;
export const routingDraftPreviewSchema = z.object({
  stage: z.literal("routing_plan"),
  revision,
  runtime_consistency: z.literal("sequential_live_reads"),
  observed_at: z.iso.datetime({ offset: true }),
  before: plan,
  after: plan,
}) satisfies z.ZodType<RoutingDraftPreviewResponse>;
export const routingDraftEndpoints = {
  preview: operation<
    WithBody<PostAdminRoutingPreviewData, RoutingDraftPreviewRequest>,
    RoutingDraftPreviewResponse
  >()("POST", "/admin/routing/preview", routingDraftPreviewSchema),
  save: operation<
    WithBody<WithQuery<PatchAdminRoutingRulesIdData, { review: "edit" }>, RoutingDraftWriteRequest>,
    RoutingDraftWriteResponse
  >()(
    "PATCH",
    "/admin/routing-rules/{id}",
    z.object({ rule: routingEditRuleSchema, revision }),
    z.object({ review: z.literal("edit") }).strict(),
  ),
} as const;
export type DraftComparison = z.output<typeof routingDraftPreviewSchema>;
export interface DraftWriteProof {
  revision: string;
  reason: string;
}
