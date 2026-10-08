import { z } from "zod";

import { operation, pathWithParams, type WithQuery } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";
import type {
  GetAdminRoutingDomainReviewData,
  PostAdminRoutingDomainReviewIdData,
  PostAdminRoutingDomainReviewIdResponse,
  RoutingDomainReviewAck as GeneratedRoutingDomainReviewAck,
  RoutingDomainReviewItem as GeneratedRoutingDomainReviewItem,
  RoutingDomainReviewReport as GeneratedRoutingDomainReviewReport,
} from "@/shared/api/generated";

export type DomainReviewStatus = "pending" | "approved" | "rejected";
export type DomainReviewAction = "approve" | "reject";
export type RoutingDomainReviewItem = Omit<GeneratedRoutingDomainReviewItem, "query_text">;
export type RoutingDomainReviewReport = Omit<GeneratedRoutingDomainReviewReport, "items"> & {
  items: RoutingDomainReviewItem[];
};
export type RoutingDomainReviewAck = GeneratedRoutingDomainReviewAck;

// The transport still includes raw query_text. This whitelist strips it and any
// unknown fields before ApiClient resolves, so success caches receive only the DTO.
// Preserve every accepted string exactly: no coercion, defaults, or trimming.
export const routingDomainReviewItemSchema = z.object({
  id: z.string(),
  decision_id: z.string(),
  suggested_route: z.string(),
  current_route: z.string(),
  reason: z.string(),
  status: z.string(),
  created_at: z.string(),
  reviewed_at: z.string(),
}) satisfies z.ZodType<RoutingDomainReviewItem>;

export const routingDomainReviewReportSchema = z.object({
  items: z
    .array(routingDomainReviewItemSchema)
    .max(200)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "검토 항목 ID가 중복되었습니다.",
    }),
}) satisfies z.ZodType<RoutingDomainReviewReport>;

export const routingDomainReviewQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  limit: z.literal(50),
});
export type RoutingDomainReviewQuery = z.input<typeof routingDomainReviewQuerySchema>;

export const routingDomainReviewAckSchema = z.object({
  id: z.string(),
  status: z.enum(["approved", "rejected"]),
}) satisfies z.ZodType<RoutingDomainReviewAck>;

export const routingDomainReviewEndpoints = {
  queue: operation<
    WithQuery<GetAdminRoutingDomainReviewData, RoutingDomainReviewQuery>,
    RoutingDomainReviewReport
  >()("GET", "/admin/routing/domain-review", routingDomainReviewReportSchema, routingDomainReviewQuerySchema),
  decide: operation<PostAdminRoutingDomainReviewIdData, PostAdminRoutingDomainReviewIdResponse>()(
    "POST",
    "/admin/routing/domain-review/{id}",
    routingDomainReviewAckSchema,
  ),
} as const;

/** Check addressability without normalizing the identity selected for review. */
export function domainReviewAddressableID(id: unknown): id is string {
  // Go TrimSpace includes NEL and excludes FEFF; JS trim would change that rule.
  if (typeof id !== "string" || /^\p{White_Space}*$/u.test(id) || id.includes("/")) return false;
  for (let index = 0; index < id.length; index += 1) {
    const unit = id.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = id.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function domainReviewDecisionEndpoint(
  id: string,
  action: DomainReviewAction,
): typeof routingDomainReviewEndpoints.decide {
  if (!domainReviewAddressableID(id) || (action !== "approve" && action !== "reject")) {
    throw new AppError("검토 항목 ID 또는 검토 동작을 확인할 수 없습니다.", { kind: "contract" });
  }
  const endpoint = routingDomainReviewEndpoints.decide;
  // The existing server splits the decoded path into <id>/<action>; the shared
  // endpoint contract carries both inside its documented {id} parameter.
  return { ...endpoint, path: pathWithParams(endpoint.path, { id: `${id}/${action}` }) };
}

/** An ACK confirms the request identity/status, not an affected-row count or CAS. */
export function domainReviewAckMatches(ack: unknown, id: string, action: DomainReviewAction): boolean {
  if (!domainReviewAddressableID(id) || (action !== "approve" && action !== "reject")) return false;
  const parsed = routingDomainReviewAckSchema.safeParse(ack);
  return (
    parsed.success &&
    parsed.data.id === id &&
    parsed.data.status === (action === "approve" ? "approved" : "rejected")
  );
}
