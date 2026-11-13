import { z } from "zod";
import { workAppDetailSchema } from "./agents.schemas";
import type { WorkAppDetail, WorkAppPage } from "../generated";

const text = z.string();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The page cache never retains component definitions or unknown fields.
export const workAppMetadataSchema = z.object({
  id: text.min(1),
  title: text,
  description: text,
  icon: text,
  allowed_teams: text,
  allowed_roles: text,
  status: text,
  owner: text,
  created_at: text,
  updated_at: text,
  component_count: count,
});
export const workAppPageSchema = z.object({
  apps: z.array(workAppMetadataSchema).max(100),
  total: count,
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
  summary: z.object({ total: count, active: count, archived: count, unscoped: count }),
}) satisfies z.ZodType<WorkAppPage>;
export const workAppReadDetailSchema = z.object({
  app: workAppDetailSchema.nullable(),
}) satisfies z.ZodType<WorkAppDetail>;
export const workAppPageQuerySchema = z.object({
  view: z.literal("page"),
  q: text.refine((value) => [...value].length <= 200).optional(),
  status: z.enum(["all", "active", "archived"]).optional(),
  sort: text.max(512).optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export const workAppDetailQuerySchema = z.object({ view: z.literal("detail"), id: text.min(1).max(4096) });
export type WorkAppMetadata = z.output<typeof workAppMetadataSchema>;
export type WorkAppPageQuery = z.input<typeof workAppPageQuerySchema>;
export type WorkAppDetailQuery = z.input<typeof workAppDetailQuerySchema>;
