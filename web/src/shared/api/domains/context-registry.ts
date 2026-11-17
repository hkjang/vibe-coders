import { validContextSort } from "@/shared/utils/context-registry-query";
import { z } from "zod";
import type { ContextRegistryMetadataPage, GetAdminContextsData } from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";

export const contextStates = ["all", "enabled", "disabled"] as const;
export const contextMetadataQuerySchema = z.strictObject({
  view: z.literal("metadata"),
  state: z.enum(contextStates),
  q: z.string().max(200).optional(),
  sort: z.string().max(100).refine(validContextSort).optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type ContextMetadataQuery = z.infer<typeof contextMetadataQuerySchema>;
const count = z.number().int().nonnegative();
const stamp = z.iso.datetime({ offset: true });
export const contextMetadataPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        key: z.string().max(2048),
        name: z.string().max(2048),
        enabled: z.boolean(),
        token_estimate: count.nullable(),
        use_count: count.nullable(),
        last_used_at: stamp.nullable(),
        updated_at: stamp.nullable(),
      }),
    )
    .max(100),
  total: count,
  limit: count.min(1).max(100),
  offset: count,
  state: z.enum(contextStates),
  generated_at: stamp,
}) satisfies z.ZodType<ContextRegistryMetadataPage>;

export const contextRegistryEndpoint = operation<
  WithQuery<GetAdminContextsData, ContextMetadataQuery>,
  ContextRegistryMetadataPage
>()("GET", "/admin/contexts", contextMetadataPageSchema, contextMetadataQuerySchema);
