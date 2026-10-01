import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type {
  GetAdminRoutingRulesData,
  GetAdminRoutingRulesResponse,
  PatchAdminRoutingRulesIdData,
  PatchAdminRoutingRulesIdResponse,
  RoutingRuleView,
} from "@/shared/api/generated";
import type { RoutingRuleToggleInput } from "./routing";

/**
 * Existing-rule review uses the actual wire fields, not the legacy list's
 * null/default coercion. Unknown future fields are discarded; known fields
 * must be present with their original type. This is not a revision/CAS proof.
 */
export const routingEditRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  match_pattern: z.string(),
  min_complexity: z.number().int(),
  max_complexity: z.number().int(),
  target_model: z.string(),
  target_provider: z.string(),
  note: z.string(),
  created_at: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<RoutingRuleView>;

export const routingEditListSchema = z.object({ rules: z.array(routingEditRuleSchema) });
export const routingEditWriteSchema = z.object({ rule: routingEditRuleSchema });
export type RoutingEditRule = z.output<typeof routingEditRuleSchema>;
export type RoutingEditInput = Omit<RoutingRuleToggleInput, "enabled">;

// Deliberately separate from the compatibility adapters used by create/toggle.
// These are the same existing business APIs, not new endpoints.
export const routingEditEndpoints = {
  list: operation<GetAdminRoutingRulesData, GetAdminRoutingRulesResponse>()(
    "GET",
    "/admin/routing-rules",
    routingEditListSchema,
  ),
  update: operation<PatchAdminRoutingRulesIdData, PatchAdminRoutingRulesIdResponse>()(
    "PATCH",
    "/admin/routing-rules/{id}",
    routingEditWriteSchema,
  ),
} as const;
