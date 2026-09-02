import type { ModelStatus } from "@/features/gateway/models/model-catalog";
import type { BadgeProps } from "@/shared/components/ui/Badge";

export const modelStatusPresentation: Record<ModelStatus, { label: string; tone: BadgeProps["tone"] }> = {
  available: { label: "Available", tone: "success" },
  virtual: { label: "Virtual", tone: "info" },
  deprecated: { label: "Deprecated", tone: "warning" },
  retired: { label: "Retired", tone: "danger" },
  stale: { label: "Stale", tone: "warning" },
  shadowed: { label: "Shadowed", tone: "muted" },
};
