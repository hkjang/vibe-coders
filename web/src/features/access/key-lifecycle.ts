import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { statusLabel, statusTone, type Tone } from "@/features/access/access-format";

export function keyDeadline(key: ApiKeyPublic): number {
  const values = [key.expires_at, ...(key.replaced_by ? [key.grace_ends_at] : [])];
  if (key.replaced_by && !key.grace_ends_at) return Number.NaN;
  return Math.min(...values.filter(Boolean).map(Date.parse));
}

export function keyLifecycle(
  key: ApiKeyPublic,
  now: number,
): {
  label: string;
  tone: Tone;
  usable: boolean;
  state: string;
  days?: number;
} {
  if (key.revoked_at || key.status === "revoked")
    return { state: "revoked", label: "폐기", tone: "danger", usable: false };
  if (key.status !== "active")
    return { state: key.status, label: statusLabel(key.status), tone: statusTone(key.status), usable: false };
  const deadline = keyDeadline(key);
  if (Number.isNaN(deadline))
    return { state: "invalid", label: "만료 시각 확인 필요", tone: "warning", usable: false };
  if (deadline <= now)
    return {
      state: key.replaced_by ? "grace-ended" : "expired",
      label: key.replaced_by ? "유예 종료" : "만료",
      tone: "muted",
      usable: false,
    };
  return {
    state: key.replaced_by ? "grace" : "active",
    label: key.replaced_by ? "교체 유예 중" : "사용",
    tone: key.replaced_by ? "warning" : "success",
    usable: true,
    days: Number.isFinite(deadline) ? Math.ceil((deadline - now) / 86_400_000) : undefined,
  };
}
