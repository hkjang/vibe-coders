import { z } from "zod";

// Keep credentials and unknown fields out of the account query cache.
// Existing account/team metadata has no such field-size cap. Limit rows and
// validate types without rejecting a page because a Legacy value is longer.
const text = z.string();
export const accountPageRowSchema = z.object({
  id: text.min(1),
  email: text,
  name: text,
  role: text,
  status: text,
  team_id: text,
  team_name: text,
  created_at: z.iso.datetime({ offset: true }),
});
export const accountPageSchema = z.object({
  accounts: z.array(accountPageRowSchema).max(100),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type AccountPage = z.output<typeof accountPageSchema>;
export type AccountRow = z.output<typeof accountPageRowSchema>;
export const accountQuerySchema = z.object({
  view: z.literal("accounts"),
  q: z
    .string()
    .refine((value) => [...value].length <= 200)
    .optional(),
  role: z.string().max(256).optional(),
  status: z.string().max(256).optional(),
  team_id: z.string().max(256).optional(),
  sort: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});
export type AccountQuery = z.input<typeof accountQuerySchema>;
