import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminRoutingRulesIdData,
  DeleteAdminRoutingRulesIdResponse,
} from "@/shared/api/generated";
import { routingEditEndpoints } from "./routing-edit";

/** An acknowledged DELETE is not evidence of prior existence or a CAS deletion. */
export const routingDeleteResponseSchema = z.object({
  id: z.string(),
  status: z.literal("deleted"),
});

export const routingDeleteEndpoints = {
  // Reuse the exact ten-field raw contract; never coerce an invalid list to [].
  list: routingEditEndpoints.list,
  remove: operation<DeleteAdminRoutingRulesIdData, DeleteAdminRoutingRulesIdResponse>()(
    "DELETE",
    "/admin/routing-rules/{id}",
    routingDeleteResponseSchema,
  ),
} as const;
