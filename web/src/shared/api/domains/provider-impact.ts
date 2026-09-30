import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type { GetAdminProviderImpactData, GetAdminProviderImpactResponse } from "@/shared/api/generated";
import { providerRefPattern } from "@/shared/api/provider-ref";

const reference = z.string().regex(providerRefPattern);
const count = z.number().int().min(0).max(1024).nullable();
const itemSchema = z.object({
  reference: z.string().regex(/^(?:impact_|prv_)[A-Za-z0-9_-]{43}$/),
  label: z.string().max(1024),
  enabled: z.boolean(),
  model: z.string().max(1024).optional(),
  provider_ref: reference.optional(),
  relation: z.enum(["direct_binding", "configured_failover_group"]).optional(),
});

const sectionSchema = z
  .object({
    status: z.enum(["complete", "partial", "denied", "unavailable"]),
    scope: z.enum([
      "direct_provider_references",
      "configured_failover_group",
      "eligible_provider_access_configuration",
      "teams_of_eligible_key_configuration",
    ]),
    reason: z.enum([
      "",
      "bounded_or_unassessable_configuration",
      "routing_read_required",
      "configuration_read_failed",
      "target_configuration_unassessable",
      "team_scoped_assessment_not_available",
      "key_configuration_unavailable",
      "team_configuration_read_failed",
    ]),
    count_kind: z.enum(["exact", "lower_bound", "unknown"]),
    scanned_count: count,
    matched_count: count,
    truncated: z.boolean(),
    items: z.array(itemSchema).max(1024),
  })
  .superRefine((section, context) => {
    const measured = section.status === "complete" || section.status === "partial";
    const valid = measured
      ? section.scanned_count !== null &&
        section.matched_count !== null &&
        section.matched_count <= section.scanned_count &&
        section.count_kind === (section.status === "complete" ? "exact" : "lower_bound") &&
        section.truncated === (section.status === "partial")
      : section.count_kind === "unknown" &&
        section.scanned_count === null &&
        section.matched_count === null &&
        section.items.length === 0;
    if (!valid) context.addIssue({ code: "custom", message: "참조 집계의 상태와 수치가 일치하지 않습니다." });
  });

export const providerImpactSchema = z.object({
  provider_ref: reference,
  provider_display: z.string().max(1024),
  generated_at: z.iso.datetime({ offset: true }),
  consistency: z.literal("best_effort"),
  is_default: z.boolean(),
  bootstrap_on_restart: z.boolean(),
  read_only: z.literal(true),
  upstream_calls: z.literal(false),
  concurrent_change_guard: z.literal(false),
  not_assessed: z
    .array(
      z.enum([
        "pattern_overlap",
        "full_model_catalog",
        "model_usage",
        "runtime_call_success",
        "ip_and_model_authorization",
        "concurrent_change_guard",
      ]),
    )
    .max(6),
  routing_rules: sectionSchema,
  agent_routes: sectionSchema,
  failover_peers: sectionSchema,
  api_keys: sectionSchema,
  teams: sectionSchema,
}) satisfies z.ZodType<GetAdminProviderImpactResponse>;

export type ProviderImpact = z.output<typeof providerImpactSchema>;
export type ProviderImpactSection = z.output<typeof sectionSchema>;

export const providerImpactEndpoint = operation<GetAdminProviderImpactData, GetAdminProviderImpactResponse>()(
  "GET",
  "/admin/provider-impact",
  providerImpactSchema,
  z.object({ provider_ref: reference }).strict(),
);
