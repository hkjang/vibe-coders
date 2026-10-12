import { z } from "zod";
import type { ChangeSet, ChangeSetDryRunCheck } from "@/shared/api/domains/system.schemas";

export const statusTones: Record<string, "danger" | "info" | "muted" | "success" | "warning"> = {
  draft: "muted",
  pending: "warning",
  approved: "info",
  apply_pending: "warning",
  applied: "success",
  rollback_pending: "warning",
  rolled_back: "muted",
};

/**
 * The approval workflow of `internal/proxy/admin_change_sets.go`: a set moves
 * draft → pending → approved → applied, and only an applied set can be rolled
 * back. `*_pending` states are resumable retries of the same server action.
 */
export type LifecycleAction = "submit" | "approve" | "apply" | "rollback" | "delete";
const statusLabels: Record<string, string> = {
  draft: "초안",
  pending: "검토 대기",
  approved: "승인됨",
  apply_pending: "적용 대기",
  applied: "적용됨",
  rollback_pending: "되돌리기 대기",
  rolled_back: "되돌림 완료",
};
export const changeSetStatusLabel = (status?: string | null): string =>
  statusLabels[status ?? ""] ?? "알 수 없음";

interface LifecycleConfig {
  confirmLabel: string;
  description: (changeSet: ChangeSet) => string;
  /** Statuses in which the server accepts this action. */
  enabledFor: readonly string[];
  errorMessage: string;
  label: string;
  /** Scope and recovery limitations shown alongside the operator's reason. */
  reasonNote?: string;
  successMessage: string;
  title: string;
  tone: "danger" | "primary";
}

export const lifecycleConfigs: Record<LifecycleAction, LifecycleConfig> = {
  submit: {
    label: "검토 제출",
    title: "검토를 요청할까요?",
    description: (changeSet) => `${changeSet.title || changeSet.id} 변경 세트를 검토 대기 상태로 보냅니다.`,
    confirmLabel: "검토 제출",
    enabledFor: ["draft"],
    tone: "primary",
    successMessage: "검토를 요청했습니다.",
    errorMessage: "검토를 요청하지 못했습니다.",
  },
  approve: {
    label: "승인",
    title: "변경 세트를 승인할까요?",
    description: (changeSet) =>
      `${changeSet.title || changeSet.id} 변경 세트가 승인되어 적용할 수 있게 됩니다. 승인자로 기록됩니다.`,
    confirmLabel: "승인",
    enabledFor: ["pending"],
    tone: "primary",
    successMessage: "변경 세트를 승인했습니다.",
    errorMessage: "변경 세트를 승인하지 못했습니다.",
  },
  apply: {
    label: "적용",
    title: "설정을 실제로 적용할까요?",
    description: (changeSet) =>
      `${changeSet.title || changeSet.id}의 설정 항목을 저장하고 응답 서버가 설정을 다시 읽습니다. 다른 서버의 즉시 반영은 보장하지 않습니다.`,
    confirmLabel: "적용",
    enabledFor: ["approved", "apply_pending"],
    tone: "danger",
    reasonNote:
      "사유를 기존 감사 API에 전달합니다. 카나리 범위는 메모이며 설정의 일부 배포를 제어하지 않습니다.",
    successMessage: "변경 세트를 적용했습니다.",
    errorMessage: "변경 세트를 적용하지 못했습니다.",
  },
  rollback: {
    label: "되돌리기",
    title: "적용 전 값으로 되돌릴까요?",
    description: (changeSet) =>
      `${changeSet.title || changeSet.id}가 적용 시점에 저장한 이전 값으로 설정을 되돌립니다.`,
    confirmLabel: "되돌리기",
    enabledFor: ["applied", "rollback_pending"],
    tone: "danger",
    reasonNote:
      "사유를 기존 감사 API에 전달합니다. 적용 이후의 다른 설정 변경을 덮어쓸 수 있으므로 이전 값을 확인하세요.",
    successMessage: "변경 세트를 적용 전 값으로 되돌렸습니다.",
    errorMessage: "변경 세트를 적용 전 값으로 되돌리지 못했습니다.",
  },
  delete: {
    label: "삭제",
    title: "변경 세트를 삭제할까요?",
    description: (changeSet) =>
      `${changeSet.title || changeSet.id} 변경 세트와 기록된 항목이 사라집니다. 이미 적용된 설정은 되돌아가지 않습니다.`,
    confirmLabel: "삭제",
    enabledFor: [
      "draft",
      "pending",
      "approved",
      "applied",
      "rolled_back",
      "apply_pending",
      "rollback_pending",
    ],
    tone: "danger",
    reasonNote: "삭제 사유를 기존 감사 API에 전달합니다. 적용된 설정을 복구하는 작업은 아닙니다.",
    successMessage: "변경 세트를 삭제했습니다.",
    errorMessage: "변경 세트를 삭제하지 못했습니다.",
  },
};

export const lifecycleOrder: readonly LifecycleAction[] = [
  "submit",
  "approve",
  "apply",
  "rollback",
  "delete",
];

export function dryRunTone(check: ChangeSetDryRunCheck): "danger" | "muted" | "success" | "warning" {
  if (check.valid === false) return "danger";
  if (check.changed === false) return "muted";
  if (check.restart_required) return "warning";
  return "success";
}

export const changeSetItemsSchema = z.array(
  z.object({
    kind: z.string().min(1),
    key: z.string().min(1),
    value: z.string(),
    note: z.string().optional(),
  }),
);

export const createSchema = z.object({
  title: z.string().trim().min(1, "제목을 입력하세요."),
  description: z.string().trim(),
  canary_scope: z.string().trim(),
  items: z
    .string()
    .trim()
    .refine((raw) => {
      if (raw === "") return true;
      try {
        return changeSetItemsSchema.safeParse(JSON.parse(raw)).success;
      } catch {
        return false;
      }
    }, "items는 {kind, key, value} 객체의 JSON 배열이어야 합니다."),
});

export type CreateValues = z.output<typeof createSchema>;

export const simulateSchema = z.object({
  change_type: z.enum(["block_model", "model_price", "route_remap"]),
  days: z
    .string()
    .trim()
    .refine((raw) => {
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90;
    }, "1~90 사이의 일수를 입력하세요."),
  pattern: z.string().trim(),
  model: z.string().trim(),
  input_krw_per_1m: z.string().trim(),
  output_krw_per_1m: z.string().trim(),
  from: z.string().trim(),
  to: z.string().trim(),
});

export type SimulateValues = z.output<typeof simulateSchema>;

export function simulateParams(values: SimulateValues): Record<string, string | number> {
  if (values.change_type === "block_model") return { pattern: values.pattern };
  if (values.change_type === "model_price") {
    return {
      model: values.model,
      input_krw_per_1m: Number(values.input_krw_per_1m) || 0,
      output_krw_per_1m: Number(values.output_krw_per_1m) || 0,
    };
  }
  return { from: values.from, to: values.to };
}
