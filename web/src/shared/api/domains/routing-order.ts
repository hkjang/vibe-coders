import { z } from "zod";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminRoutingRulesData,
  PatchAdminRoutingRulesData,
  PostAdminRoutingPreviewData,
  RoutingOrderSnapshot,
  RoutingOrderPreviewResponse,
} from "@/shared/api/generated";
import { routingEditRuleSchema } from "./routing-edit";

const revision = z.string().regex(/^[a-f0-9]{64}$/u);
export const routingOrderSnapshotSchema = z
  .object({
    rules: z.array(routingEditRuleSchema).max(1000),
    revision,
    ambiguous_ties: z.boolean(),
  })
  .refine(
    (value) => new Set(value.rules.map((rule) => rule.id)).size === value.rules.length,
  ) satisfies z.ZodType<RoutingOrderSnapshot>;
const decision = z.object({
  matched_rule_id: z.string(),
  applied: z.boolean(),
  target_model: z.string(),
  target_provider: z.string(),
});
export const routingOrderPreviewSchema = z.object({
  stage: z.literal("complexity_rules"),
  revision,
  ambiguous_before_order: z.boolean(),
  before: decision,
  after: decision,
}) satisfies z.ZodType<RoutingOrderPreviewResponse>;
export const routingOrderEndpoints = {
  snapshot: operation<WithQuery<GetAdminRoutingRulesData, { view: "order" }>, RoutingOrderSnapshot>()(
    "GET",
    "/admin/routing-rules",
    routingOrderSnapshotSchema,
    z.object({ view: z.literal("order") }).strict(),
  ),
  save: operation<PatchAdminRoutingRulesData, RoutingOrderSnapshot>()(
    "PATCH",
    "/admin/routing-rules",
    routingOrderSnapshotSchema,
  ),
  preview: operation<PostAdminRoutingPreviewData, RoutingOrderPreviewResponse>()(
    "POST",
    "/admin/routing/preview",
    routingOrderPreviewSchema,
  ),
} as const;
export type OrderSnapshot = z.infer<typeof routingOrderSnapshotSchema>;
export type OrderPreview = z.infer<typeof routingOrderPreviewSchema>;
