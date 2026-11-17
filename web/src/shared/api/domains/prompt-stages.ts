import { z } from "zod";
import type {
  GetAdminPromptsPromotionsData,
  PostAdminPromptsPromotionsData,
  PromptStageWorkspacePage,
  PromptStageChange,
  PromptStageChangeReceipt,
} from "@/shared/api/generated";
import { operation, type WithQuery, type WithBody } from "@/shared/api/endpoint-factory";
export const promptStages = ["experiment", "validation", "production"] as const;
export const stageWindows = ["1h", "24h", "7d", "30d"] as const;
export const stageQuerySchema = z.strictObject({
  view: z.literal("workspace"),
  window: z.enum(stageWindows),
  stage: z.enum(["all", ...promptStages]),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type StageQuery = z.infer<typeof stageQuerySchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reference = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const stamp = z.iso.datetime({ offset: true });
const criterion = z.strictObject({
  stage: z.enum(["validation", "production"]),
  minimum_calls: count,
  maximum_error_rate: z.number().min(0).max(1),
  maximum_evaluation_failures_per_call: z.number().nonnegative(),
});
export const stagePageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        reference,
        name: z.string().max(256),
        version: z.string().max(256),
        stage: z.enum([...promptStages, "unknown"]),
        registered: z.boolean(),
        can_change: z.boolean(),
        revision: z.union([reference, z.literal("")]),
        calls: count,
        errors: count,
        evaluation_failures: count,
        eligible_stage: z.enum(["", "validation", "production"]),
        updated_at: stamp.nullable(),
      }),
    )
    .max(100),
  total: count,
  limit: count.min(1).max(100),
  offset: count.max(1_000_000),
  stage: z.enum(["all", ...promptStages]),
  window: z.enum(stageWindows),
  since: stamp,
  until: stamp,
  criteria: z.tuple([criterion, criterion]),
}) satisfies z.ZodType<PromptStageWorkspacePage>;
export const stageReceiptSchema = z.strictObject({
  reference,
  stage: z.enum(promptStages),
  updated_at: stamp,
  revision: reference,
}) satisfies z.ZodType<PromptStageChangeReceipt>;
export const stageEndpoints = {
  list: operation<WithQuery<GetAdminPromptsPromotionsData, StageQuery>, PromptStageWorkspacePage>()(
    "GET",
    "/admin/prompts/promotions",
    stagePageSchema,
    stageQuerySchema,
  ),
  change: operation<
    WithQuery<WithBody<PostAdminPromptsPromotionsData, PromptStageChange>, { view: "workspace" }>,
    PromptStageChangeReceipt
  >()(
    "POST",
    "/admin/prompts/promotions",
    stageReceiptSchema,
    z.strictObject({ view: z.literal("workspace") }),
  ),
};
