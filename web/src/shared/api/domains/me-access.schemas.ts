import { z } from "zod";

const text = z.string().max(8_192);
const label = text.nullish().transform((value) => value ?? "");
const strings = z
  .array(text)
  .nullable()
  .transform((value) => value ?? []);
export const meAccessSessionSchema = z.object({
  id: z.string().min(1).max(512),
  ip: label,
  user_agent: label,
  created_at: label,
  expires_at: label,
  sso_linked: z.boolean().optional(),
  current: z.boolean().optional(),
});
export const meSessionsSchema = z.object({
  current_session_id: label,
  sessions: z
    .array(meAccessSessionSchema)
    .nullable()
    .transform((rows) => rows ?? []),
});
export type MeSession = z.output<typeof meAccessSessionSchema>;
export const meSessionRevokedSchema = z.object({
  status: z.literal("revoked"),
  session_id: z.string().min(1).max(512),
});
export const meSessionsRevokedSchema = z.object({
  status: z.literal("revoked"),
  revoked_count: z.number().int().nonnegative(),
});
export const meConnectionDoctorSchema = z.object({
  client: z.string().min(1).max(80),
  overall: z.enum(["pass", "warn", "fail"]),
  base_url: text,
  mcp_url: text,
  auth_mode: z.enum(["jwt", "proxy_key"]).optional(),
  note: label,
  checks: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        status: z.enum(["pass", "warn", "fail", "skip"]),
        detail: label,
        fix: label,
      }),
    )
    .min(1)
    .max(32),
});
// Connection examples are formatted from these allowlisted fields. Server
// command/config text is not stored in the browser query cache or copied.
export const meOnboardingPackSchema = z.object({
  client: z.string().min(1).max(80),
  base_url: text,
  mcp_url: text,
  available_models: strings,
  recommended_models: strings,
  scopes: strings,
  budget_limit_krw: z.number().finite().nonnegative().optional(),
});
