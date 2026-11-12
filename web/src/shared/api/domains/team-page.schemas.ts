import { z } from "zod";
import { teamSummarySchema } from "./access.schemas";

// Preserve existing metadata without retaining unknown credential fields.
export const registeredTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export const registeredTeamPageSchema = z.object({
  auth_teams: z.array(registeredTeamSchema).max(100),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type RegisteredTeamPage = z.output<typeof registeredTeamPageSchema>;
export const registeredTeamQuerySchema = z.object({
  view: z.literal("registered"),
  q: z
    .string()
    .refine((value) => [...value].length <= 200)
    .optional(),
  sort: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type RegisteredTeamQuery = z.input<typeof registeredTeamQuerySchema>;
export const teamUsageSchema = z.object({ teams: z.array(teamSummarySchema) });
