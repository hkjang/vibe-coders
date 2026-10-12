import { z } from "zod";
import { operation } from "@/shared/api/endpoint-factory";
import type { PostAdminResourceSearchData, PostAdminResourceSearchResponse } from "@/shared/api/generated";

export const resourceKindSchema = z.enum(["provider", "workflow", "app", "skill", "mcp_upstream"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
const boundedText = (characters: number) =>
  z
    .string()
    .min(1)
    .max(characters * 2)
    .refine((value) => [...value].length <= characters);
export const resourceSearchSchema = z.strictObject({
  request_id: z.string(),
  groups: z
    .array(
      z.strictObject({
        kind: resourceKindSchema,
        status: z.enum(["ok", "forbidden", "unavailable"]),
        limited: z.boolean(),
        items: z
          .array(
            z.strictObject({
              kind: resourceKindSchema,
              id: boundedText(512),
              title: boundedText(256),
            }),
          )
          .max(10),
      }),
    )
    .max(5),
}) satisfies z.ZodType<PostAdminResourceSearchResponse>;

export const resourceSearchEndpoint = operation<
  PostAdminResourceSearchData,
  PostAdminResourceSearchResponse
>()("POST", "/admin/resource-search", resourceSearchSchema);
