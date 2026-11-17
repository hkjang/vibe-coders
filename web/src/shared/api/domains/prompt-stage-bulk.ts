import { z } from "zod";
import type {
  GetAdminPromptsPromotionsData,
  PostAdminPromptsPromotionsData,
  PromptStageBulkReview,
  PromptStageBulkApply,
  PromptStageBulkReceipt,
} from "@/shared/api/generated";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import { stagePageSchema, stageWindows } from "./prompt-stages";

const count = z.number().int().min(0).max(1000);
const stamp = z.iso.datetime({ offset: true });
const revision = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const stageBulkReviewSchema = z.strictObject({
  window: z.enum(stageWindows),
  since: stamp,
  until: stamp,
  expires_at: stamp,
  revision: z.union([revision, z.literal("")]),
  items: z.array(stagePageSchema.shape.items.element).max(1000),
  observed_count: count,
  ignored_count: count,
  blocked_count: count,
  criteria: stagePageSchema.shape.criteria,
}) satisfies z.ZodType<PromptStageBulkReview>;
const querySchema = z.strictObject({ view: z.literal("promotion-review"), window: z.enum(stageWindows) });
export const stageBulkEndpoints = {
  review: operation<
    WithQuery<GetAdminPromptsPromotionsData, z.infer<typeof querySchema>>,
    PromptStageBulkReview
  >()("GET", "/admin/prompts/promotions", stageBulkReviewSchema, querySchema),
  apply: operation<
    WithQuery<WithBody<PostAdminPromptsPromotionsData, PromptStageBulkApply>, { view: "promotion-review" }>,
    PromptStageBulkReceipt
  >()(
    "POST",
    "/admin/prompts/promotions",
    z.strictObject({ count: count.min(1), updated_at: stamp, review_revision: revision }),
    z.strictObject({ view: z.literal("promotion-review") }),
  ),
};
