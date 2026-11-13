import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";

export function validReceiptId(value: string, prefixes: readonly string[]): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 4096 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}

export function readRunSelection(
  params: URLSearchParams,
  resource: "app" | "workflow",
  prefixes: readonly string[],
) {
  const open = params.has("run");
  const id = params.get("run") ?? "";
  const invalid =
    open && (params.getAll("run").length !== 1 || params.has(resource) || !validReceiptId(id, prefixes));
  return { open, invalid, id: open && !invalid ? id : "" };
}

const states = {
  ok: { label: "완료", tone: "success" },
  error: { label: "오류", tone: "danger" },
  planned: { label: "계획됨", tone: "info" },
  pending_approval: { label: "승인 대기", tone: "warning" },
  condition_failed: { label: "조건 불충족", tone: "warning" },
  passed: { label: "통과", tone: "success" },
  stopped: { label: "중단", tone: "warning" },
  skipped: { label: "건너뜀", tone: "muted" },
} as const;
export function runState(value: string | undefined) {
  return Object.hasOwn(states, value ?? "")
    ? states[value as keyof typeof states]
    : { label: value ? "상태 확인 필요" : "—", tone: "muted" as const };
}

export function appRunSummary(value: string | undefined): string {
  const planned = /^([0-9]{1,9}) components planned$/.exec(value ?? "");
  return planned ? `구성 요소 ${formatNumber(Number(planned[1]))}개 계획됨` : value || "—";
}

export const receiptText = {
  invalidTitle: "영수증 주소를 확인하세요.",
  invalidDescription: "실행 ID 하나만 지정하세요. 정의 상세 주소와 함께 지정할 수 없습니다.",
  missingTitle: "실행 영수증을 찾을 수 없습니다.",
  missingDescription: "실행 ID를 확인하거나 실행 이력에서 다시 선택하세요.",
} as const;
