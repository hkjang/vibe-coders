import { z } from "zod";
import type {
  GetAdminText2SqlProfilesData,
  PutAdminText2SqlProfilesData,
  Text2SqlProfileReview,
  Text2SqlProfileSaved,
  PostAdminText2SqlProfilesReviewedDeleteData,
  Text2SqlProfileReviewedDeleted,
} from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";

const revision = z.string().regex(/^[0-9a-f]{64}$/u);
export const reviewedProfileSchema = z.object({
  virtual_model: z.string().min(1),
  mode: z.enum(["preview", "execute"]),
  upstream_model: z.string(),
  summary_model: z.string(),
  schema_name: z.string(),
  exec_connection_id: z.string(),
  enabled: z.boolean(),
  updated_at: z.string().min(1),
  revision,
});
export const profileReviewSchema = z
  .object({
    review_supported: z.literal(true),
    profile: reviewedProfileSchema.nullable(),
    revision: z.union([revision, z.literal("absent")]),
  })
  .refine(
    (value) => (value.profile ? value.profile.revision === value.revision : value.revision === "absent"),
    "프로필 검토 기준이 일치하지 않습니다.",
  ) satisfies z.ZodType<Text2SqlProfileReview>;

export const text2sqlProfileReviewEndpoints = {
  review: operation<
    WithQuery<GetAdminText2SqlProfilesData, { view: "review"; virtual_model: string }>,
    z.infer<typeof profileReviewSchema>
  >()(
    "GET",
    "/admin/text2sql/profiles",
    profileReviewSchema,
    z.object({ view: z.literal("review"), virtual_model: z.string().min(1) }),
  ),
  saveReviewed: operation<PutAdminText2SqlProfilesData, Text2SqlProfileSaved>()(
    "PUT",
    "/admin/text2sql/profiles",
    z.object({ profile: reviewedProfileSchema }),
  ),
  deleteReviewed: operation<PostAdminText2SqlProfilesReviewedDeleteData, Text2SqlProfileReviewedDeleted>()(
    "POST",
    "/admin/text2sql/profiles/reviewed-delete",
    z.object({ virtual_model: z.string().min(1), status: z.literal("deleted"), reviewed_revision: revision }),
  ),
};
export type ProfileReviewSnapshot = z.infer<typeof profileReviewSchema>;
export type ReviewedProfile = z.infer<typeof reviewedProfileSchema>;
export type ProfileReviewInput = NonNullable<PutAdminText2SqlProfilesData["body"]>;
export type ProfileDeleteReviewInput = NonNullable<PostAdminText2SqlProfilesReviewedDeleteData["body"]>;
