import { z } from "zod";

// GET and successful POST return both confirmed values. Missing, null, strings
// and non-finite numbers must never become a fabricated disabled/zero setting.
export const costGuardSchema = z.object({
  enabled: z.boolean(),
  threshold_krw: z.number().finite().min(0),
});
export type CostGuard = z.infer<typeof costGuardSchema>;

export const costGuardQueryKeys = {
  governance: ["governance", "cost-guard"],
  routing: ["routing", "cost-guard"],
} as const;
