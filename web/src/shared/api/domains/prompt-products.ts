import { z } from "zod";
import type { GetAdminPromptProductsData, PromptProductMetadataPage } from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";

export const productStates = ["all", "enabled", "disabled", "missing"] as const;
export const productMetadataQuerySchema = z.strictObject({
  view: z.literal("metadata"),
  state: z.enum(productStates),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type ProductMetadataQuery = z.infer<typeof productMetadataQuerySchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stamp = z.iso.datetime({ offset: true });
export const productMetadataPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: z.string().max(2048),
        category: z.string().max(2048),
        template_state: z.enum(["enabled", "disabled", "missing"]),
        source_requests: count.nullable(),
        source_distinct_keys: count.nullable(),
        use_count: count.nullable(),
        last_used_at: stamp.nullable(),
        created_at: stamp.nullable(),
      }),
    )
    .max(100),
  total: count,
  limit: count.min(1).max(100),
  offset: count.max(1_000_000),
  state: z.enum(productStates),
  generated_at: stamp,
}) satisfies z.ZodType<PromptProductMetadataPage>;

export const productRegistryEndpoint = operation<
  WithQuery<GetAdminPromptProductsData, ProductMetadataQuery>,
  PromptProductMetadataPage
>()("GET", "/admin/prompt-products", productMetadataPageSchema, productMetadataQuerySchema);
