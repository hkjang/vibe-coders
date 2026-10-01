import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type {
  PostAdminRoutingRulesData,
  PostAdminRoutingRulesResponse,
  RoutingRuleWriteResponse,
} from "@/shared/api/generated";
import type { RoutingRuleInput } from "./routing";
import { routingEditEndpoints, routingEditRuleSchema } from "./routing-edit";

export type RoutingCreateInput = RoutingRuleInput;

/** Preserve all raw fields, including the current server's zero creation ACK time. */
export const routingCreateRuleSchema = routingEditRuleSchema.extend({
  id: z
    .string()
    .min(1)
    .refine((value) => value.trim().replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").length > 0),
});
export const routingCreateWriteSchema = z.object({
  rule: routingCreateRuleSchema,
}) satisfies z.ZodType<RoutingRuleWriteResponse>;

// The existing compatibility adapter remains unchanged for learning and other
// callers. This form alone uses the generated POST contract and strict ACK.
export const routingCreateEndpoints = {
  list: routingEditEndpoints.list,
  create: operation<PostAdminRoutingRulesData, PostAdminRoutingRulesResponse>()(
    "POST",
    "/admin/routing-rules",
    routingCreateWriteSchema,
  ),
} as const;
