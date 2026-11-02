import type { RoleRow } from "@/shared/api/domains/access.schemas";
import { scopeTitle } from "./role-permission-matrix";

export type RoleDraft = Pick<RoleRow, "role" | "description" | "default_home" | "scopes">;
export interface RoleChange {
  id: string;
  label: string;
  before: string;
  after: string;
}

/** Match the existing server's trimming and scope-set semantics, without mutating a draft. */
export function roleChanges(baseline: RoleDraft | undefined, draft: RoleDraft) {
  const changes: RoleChange[] = [];
  const fields = [
    ["role", "역할 이름", "새 역할"],
    ["description", "설명", "미지정"],
    ["default_home", "기본 화면", "서버 기본값"],
  ] as const;
  for (const [id, label, empty] of fields) {
    const before = baseline?.[id].trim() ?? "";
    const after = draft[id].trim();
    if (before !== after) changes.push({ id, label, before: before || empty, after: after || empty });
  }
  const beforeScopes = new Set(baseline?.scopes ?? []);
  const afterScopes = new Set(draft.scopes);
  const added = [...afterScopes].filter((scope) => !beforeScopes.has(scope)).sort();
  const removed = [...beforeScopes].filter((scope) => !afterScopes.has(scope)).sort();
  for (const scope of [...new Set([...added, ...removed])].sort()) {
    changes.push({
      id: `scope:${scope}`,
      label: `${scopeTitle(scope)} (${scope})`,
      before: beforeScopes.has(scope) ? "부여됨" : "미부여",
      after: afterScopes.has(scope) ? "부여됨" : "미부여",
    });
  }
  return { changes, added, removed };
}
