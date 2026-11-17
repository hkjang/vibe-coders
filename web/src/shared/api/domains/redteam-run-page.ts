import { z } from "zod";
import type { GetAdminRedteamRunsData, RedTeamRunMetadata, RedTeamRunPage } from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import {
  runKinds,
  runModes,
  runStatuses,
  validRunRef,
  validRunSort,
  validRunWindow,
} from "@/shared/utils/redteam-run-query";

const count = z.number().int().nonnegative();
const text = z.string().max(2048);
const ref = z.string().refine((value) => validRunRef(value));
export const runMetadataSchema = z.strictObject({
  id: text.min(1),
  campaign_id: text,
  target_id: text,
  started_at: text,
  ended_at: text,
  created_at: text,
  status: text,
  mode: text,
  source_result_id: text.optional(),
  review_id: text.optional(),
  total_cases: count,
  failed_cases: count,
  risk_score: count,
  cost_krw: z.number().nonnegative(),
}) satisfies z.ZodType<RedTeamRunMetadata>;
export const runPageSchema = z.strictObject({
  runs: z.array(runMetadataSchema).max(100),
  total: count,
  limit: count.min(1).max(100),
  offset: count.max(1_000_000),
  generated_at: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<RedTeamRunPage>;
export const runPageQuerySchema = z
  .strictObject({
    view: z.literal("page"),
    limit: count.min(1).max(100),
    offset: count.max(1_000_000),
    status: z.enum(runStatuses).optional(),
    mode: z.enum(runModes).optional(),
    kind: z.enum(runKinds).optional(),
    run_id: ref.optional(),
    campaign_id: ref.optional(),
    source_result_id: ref.optional(),
    review_id: ref.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    sort: z.string().refine(validRunSort).optional(),
  })
  .refine((query) => validRunWindow(query.from ?? "", query.to ?? ""));
export type RunPageQuery = z.infer<typeof runPageQuerySchema>;
export const runPageEndpoint = operation<WithQuery<GetAdminRedteamRunsData, RunPageQuery>, RedTeamRunPage>()(
  "GET",
  "/admin/redteam/runs",
  runPageSchema,
  runPageQuerySchema,
);
