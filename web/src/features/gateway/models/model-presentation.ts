import type { ModelStatus } from "@/features/gateway/models/model-catalog";
import type { BadgeProps } from "@/shared/components/ui/Badge";

export const modelStatusPresentation: Record<ModelStatus, { label: string; tone: BadgeProps["tone"] }> = {
  available: { label: "사용 가능", tone: "success" },
  virtual: { label: "가상", tone: "info" },
  deprecated: { label: "지원 종료 예정", tone: "warning" },
  retired: { label: "종료", tone: "danger" },
  stale: { label: "이전 데이터", tone: "warning" },
  shadowed: { label: "우선순위 밀림", tone: "muted" },
};

export const modelSourceLabels = {
  live: "실시간",
  cache: "캐시",
  agent_route: "에이전트 경로",
} as const;
