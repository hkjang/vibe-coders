import { z } from "zod";

import type { AppPermission } from "@/shared/api/domains/agents.schemas";

export const appPermissionSchema = z.object({
  subject_type: z.enum(["user", "team"]),
  subject_id: z.string().trim().min(1, "대상 ID를 입력하세요."),
});
export type AppPermissionValues = z.infer<typeof appPermissionSchema>;

export const appPermissionTypes = [
  { value: "user", label: "사용자" },
  { value: "team", label: "팀" },
];

/** Existing opaque IDs must survive validation exactly, not become another DELETE tuple.
 * In particular, JavaScript trim removes U+FEFF while Go strings.TrimSpace does not.
 * Conversely, Go trims edge U+0085 (NEL), which JavaScript trim preserves.
 */
export function appPermissionTarget(permission: AppPermission): AppPermissionValues | undefined {
  const parsed = appPermissionSchema.safeParse(permission);
  return parsed.success &&
    parsed.data.subject_id === permission.subject_id &&
    !parsed.data.subject_id.startsWith("\u0085") &&
    !parsed.data.subject_id.endsWith("\u0085")
    ? parsed.data
    : undefined;
}

export const appPermissionDescription =
  "활성 앱에서 기존 팀·역할 조건을 통과하지 못하는 사용자나 팀에게 추가 접근을 허용합니다. 기존 팀·역할 조건은 바뀌지 않습니다.";
export const appPermissionRevokeDescription =
  "이 추가 권한만 회수합니다. 기존 팀·역할 조건이나 다른 추가 권한으로 접근할 수 있다면 앱 접근이 계속 허용됩니다. 전체 접근을 금지하는 작업이 아닙니다.";

export function appPermissionKey(appId: string) {
  return ["agents", "apps", appId, "permissions"] as const;
}
