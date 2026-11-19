import { z } from "zod";
import type {
  PostAdminRedteamProbePacksImportReviewData,
  PutAdminRedteamProbePacksImportData,
  RedTeamProbeCsvReview,
  RedTeamProbeCsvApplied,
} from "@/shared/api/generated";
import { textOperation } from "@/shared/api/endpoint-factory";

const text = z.string();
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0).max(20_000);
const rows = z.number().int().min(1).max(10_000);
const pack = z.strictObject({
  id: text,
  name: text,
  category: text,
  severity: text,
  version: text,
  enabled: z.boolean(),
  requires_approval: z.boolean(),
});
const probe = z.strictObject({
  id: text,
  pack_id: text,
  case_key: text,
  input_template: text,
  expected_policy: text,
  evaluator_type: text,
  severity: text,
  risk_tags: z.array(text),
  target_types: z.array(text),
});
const action = z.enum(["create", "update", "unchanged"]);
export const probeCsvChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pack"), id: text, action, before: pack.nullable(), after: pack }),
  z.strictObject({ kind: z.literal("case"), id: text, action, before: probe.nullable(), after: probe }),
]);
const skipped = z
  .array(text)
  .max(10_000)
  .nullable()
  .transform((value) => value ?? []);
export const probeCsvReviewSchema = z
  .strictObject({
    review_supported: z.literal(true),
    revision,
    file_sha256: revision,
    imported_cases: rows,
    packs_touched: rows,
    skipped,
    counts: z.strictObject({ created: count, updated: count, unchanged: count }),
    total_items: count,
    offset: count,
    limit: z.number().int().min(1).max(100),
    has_more: z.boolean(),
    changes: z.array(probeCsvChangeSchema).max(100),
  })
  .superRefine((value, context) => {
    const end = value.offset + value.changes.length;
    const ids = new Set(value.changes.map((change) => change.kind + ":" + change.id));
    if (
      value.counts.created + value.counts.updated + value.counts.unchanged !== value.total_items ||
      value.total_items === 0 ||
      value.offset > value.total_items ||
      value.changes.length !== Math.min(value.limit, value.total_items - value.offset) ||
      value.has_more !== end < value.total_items ||
      ids.size !== value.changes.length ||
      value.changes.some(
        (change) =>
          change.after.id !== change.id ||
          (change.before !== null && change.before.id !== change.id) ||
          (change.action === "create") !== (change.before === null),
      )
    )
      context.addIssue({ code: "custom", message: "Inconsistent CSV review" });
  });
export const probeCsvAppliedSchema = z.strictObject({
  review_applied: z.literal(true),
  applied_revision: revision,
  imported_cases: rows,
  packs_touched: rows,
  skipped,
});
const csv = { contentType: "text/csv", maxBytes: 8 * 1024 * 1024 } as const;
export const probeCsvReviewedEndpoints = {
  review: textOperation<PostAdminRedteamProbePacksImportReviewData, RedTeamProbeCsvReview>()(
    "POST",
    "/admin/redteam/probe-packs/import-review",
    probeCsvReviewSchema,
    csv,
    z.strictObject({
      offset: z.number().int().min(0).max(20_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  ),
  apply: textOperation<PutAdminRedteamProbePacksImportData, RedTeamProbeCsvApplied>()(
    "PUT",
    "/admin/redteam/probe-packs/import",
    probeCsvAppliedSchema,
    csv,
  ),
} as const;
export type ProbeCsvReview = z.output<typeof probeCsvReviewSchema>;
export type ProbeCsvChange = z.output<typeof probeCsvChangeSchema>;
