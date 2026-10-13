import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { statusLabel, statusTone, type Tone } from "@/features/access/access-format";

export function meKeyDeadline(key: ApiKeyPublic): number {
  const values = [key.expires_at, ...(key.replaced_by ? [key.grace_ends_at] : [])];
  if (key.replaced_by && !key.grace_ends_at) return Number.NaN;
  return Math.min(...values.filter(Boolean).map(Date.parse));
}

export function meKeyLifecycle(
  key: ApiKeyPublic,
  now: number,
): {
  label: string;
  tone: Tone;
  usable: boolean;
  days?: number;
} {
  if (key.revoked_at || key.status === "revoked") return { label: "폐기", tone: "danger", usable: false };
  if (key.status !== "active")
    return { label: statusLabel(key.status), tone: statusTone(key.status), usable: false };
  const deadline = meKeyDeadline(key);
  if (Number.isNaN(deadline)) return { label: "만료 시각 확인 필요", tone: "warning", usable: false };
  if (deadline <= now) return { label: key.replaced_by ? "유예 종료" : "만료", tone: "muted", usable: false };
  return {
    label: key.replaced_by ? "교체 유예 중" : "사용",
    tone: key.replaced_by ? "warning" : "success",
    usable: true,
    days: Number.isFinite(deadline) ? Math.ceil((deadline - now) / 86_400_000) : undefined,
  };
}
