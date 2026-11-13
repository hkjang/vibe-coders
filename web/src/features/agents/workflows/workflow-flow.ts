import type { WorkflowStep } from "@/shared/api/domains/agents.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";
import { workflowStepTypeLabels } from "./workflow-form";

export const flowPageSize = 25;
export const flowText = {
  description: "저장된 단계 순서입니다. 단계를 선택해 참조와 등록 한도를 확인하세요.",
  boundary: "조건·승인 단계의 실제 처리 결과는 실행 영수증에서 확인할 수 있습니다.",
  limits: "정의에 등록된 값입니다. 실제 적용 범위는 실행 방식과 정책에 따라 달라집니다.",
  protected: "민감정보가 포함될 수 있어 표시하지 않습니다.",
} as const;

export function flowDisplay(value: string | undefined, prefixes: readonly string[]): string {
  if (!value) return "—";
  if (containsPotentialSecret(value, prefixes)) return flowText.protected;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return clean.length > 600 ? `${clean.slice(0, 600)}…` : clean || "—";
}

export function flowType(step: WorkflowStep): string {
  const type = step.type ?? "";
  return Object.hasOwn(workflowStepTypeLabels, type)
    ? workflowStepTypeLabels[type as keyof typeof workflowStepTypeLabels]
    : "알 수 없는 종류";
}

export function flowLimit(value: number | undefined, unit: string): string {
  if (value === undefined || value === 0) return "등록 안 함";
  if (!Number.isFinite(value) || value < 0) return "값 확인 필요";
  return `${formatNumber(value, unit === "원" ? 2 : 0)} ${unit}`;
}
