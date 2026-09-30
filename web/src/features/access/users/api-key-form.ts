import { z } from "zod";

export const createKeySchema = z.object({
  name: z.string().min(1, "키 이름을 입력하세요."),
  owner: z.string(),
  team: z.string(),
  role: z.string(),
  allowed_ips: z.string(),
  allowed_models: z.string(),
  denied_models: z.string(),
  budget_limit_krw: z.string(),
  expires_at: z.string(),
  scopes: z.array(z.string()),
});
export type CreateKeyForm = z.infer<typeof createKeySchema>;

export const editKeySchema = z.object({
  name: z.string(),
  owner: z.string(),
  team: z.string(),
  role: z.string(),
  status: z.enum(["active", "disabled"]),
});
export type EditKeyForm = z.infer<typeof editKeySchema>;

export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
