import { z } from "zod";

const text = z.string();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metadata = {
  id: text.min(1),
  name: text,
  description: text,
  allowed_teams: text,
  enabled: z.boolean(),
  created_by: text,
  created_at: text,
  updated_at: text,
};
// Strip unknown properties before caching; the list never keeps step bodies.
export const workflowMetadataSchema = z.object({ ...metadata, step_count: count });
export const workflowPageSchema = z.object({
  workflows: z.array(workflowMetadataSchema).max(100),
  total: count,
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
  summary: z.object({ total: count, enabled: count }),
});
export const workflowDefinitionSchema = z.object({
  ...metadata,
  steps: z
    .array(
      z.object({
        name: text,
        type: text,
        ref: text.optional(),
        note: text.optional(),
        timeout_ms: z.number().int().optional(),
        max_tokens: z.number().int().optional(),
        max_cost_krw: z.number().optional(),
        allowed_tools: z.array(text).optional(),
        allowed_tables: z.array(text).optional(),
      }),
    )
    .nullable(),
});
export const workflowDetailSchema = z.object({ workflow: workflowDefinitionSchema.nullable() });
export const workflowPageQuerySchema = z.object({
  view: z.literal("page"),
  q: text.refine((value) => [...value].length <= 200).optional(),
  status: z.enum(["all", "enabled", "disabled"]).optional(),
  sort: text.max(512).optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export const workflowDetailQuerySchema = z.object({ view: z.literal("detail"), id: text.min(1).max(4096) });
export type WorkflowMetadata = z.output<typeof workflowMetadataSchema>;
export type WorkflowPageQuery = z.input<typeof workflowPageQuerySchema>;
export type WorkflowDetailQuery = z.input<typeof workflowDetailQuerySchema>;
