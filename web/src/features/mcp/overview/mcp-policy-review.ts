import { z } from "zod";
import type { mcpPolicyListSchema, McpPolicy } from "@/shared/api/domains/mcp.schemas";

export type PolicySnapshot = z.output<typeof mcpPolicyListSchema>;
export type PolicyCommand =
  | {
      kind: "save";
      before: PolicySnapshot;
      original?: McpPolicy;
      server_label: string;
      mode: string;
      note: string;
    }
  | { kind: "delete"; before: PolicySnapshot; original: McpPolicy }
  | { kind: "allowlist"; before: PolicySnapshot; enabled: boolean };

export const policyFormSchema = z.object({
  server_label: z.string().trim().min(1, "서버 라벨을 입력하세요."),
  mode: z.enum(["allow", "warn", "block"], { error: "지원하는 모드를 선택하세요." }),
  note: z.string().trim(),
});
export interface PolicyDraft {
  server_label: string;
  mode: string;
  note: string;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
export function policyUnchanged(command: PolicyCommand, latest: PolicySnapshot): boolean {
  if (command.before.allowlist_enabled !== latest.allowlist_enabled) return false;
  if (command.kind === "allowlist") {
    const rows = (snapshot: PolicySnapshot) =>
      [...snapshot.policies].sort((a, b) =>
        a.server_label < b.server_label ? -1 : a.server_label > b.server_label ? 1 : 0,
      );
    return fingerprint(rows(command.before)) === fingerprint(rows(latest));
  }
  const server = command.kind === "delete" ? command.original.server_label : command.server_label;
  const current = latest.policies.filter((row) => row.server_label === server);
  if (!command.original)
    return current.length === 0 && !command.before.policies.some((row) => row.server_label === server);
  return current.length === 1 && fingerprint(command.original) === fingerprint(current[0]);
}
export function canDeletePolicy(server: string): boolean {
  try {
    encodeURIComponent(server);
    return server !== "" && server !== "." && server !== ".." && !/[\p{Cc}/]/u.test(server);
  } catch {
    return false;
  }
}
