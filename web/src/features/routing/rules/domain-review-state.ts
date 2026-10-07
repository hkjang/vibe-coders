import {
  domainReviewAddressableID,
  type DomainReviewAction,
  type DomainReviewStatus,
  type RoutingDomainReviewItem,
  type RoutingDomainReviewReport,
} from "@/shared/api/domains/routing-domain-review";
import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { shortId } from "@/shared/utils/format";

export const domainReviewStatuses = ["pending", "approved", "rejected"] as const;
export const domainReviewStatusLabels: Record<DomainReviewStatus, string> = {
  pending: "검토 대기",
  approved: "승인 기록",
  rejected: "거절 기록",
};
export const domainReviewChanged =
  "검토 목록 또는 권한 기준이 바뀌었습니다. 목록을 다시 조회하고 기록할 상태를 다시 검토하세요.";
export const domainReviewUnconfirmed =
  "현재 최대 50건의 응답에서 원래 검토 대기 항목과 같은 내용을 확인할 수 없습니다. 삭제되었다는 뜻은 아닙니다. 창을 닫고 목록에서 다시 선택하세요.";
export const domainReviewAcknowledged = "검토 상태 기록 요청을 확인했습니다.";
export const domainReviewProtected = "민감정보가 포함될 수 있어 표시하지 않습니다.";
export const domainReviewFields = [
  ["id", "검토 ID"],
  ["decision_id", "결정 ID"],
  ["current_route", "기록 당시 모델"],
  ["suggested_route", "제안 라우트"],
  ["reason", "사유"],
  ["status", "원래 검토 상태"],
  ["created_at", "등록 시각"],
  ["reviewed_at", "검토 시각"],
] as const;
export interface DomainReviewSource {
  readonly item: Readonly<RoutingDomainReviewItem>;
  readonly action: DomainReviewAction;
  readonly status: DomainReviewStatus;
}
export function domainReviewText(value: string, prefixes: readonly string[], empty = "없음") {
  return containsPotentialSecret(value, prefixes) ? domainReviewProtected : value || empty;
}
export function domainReviewStatusText(value: string, prefixes: readonly string[], includeRaw = false) {
  if (!(domainReviewStatuses as readonly string[]).includes(value)) return domainReviewText(value, prefixes);
  const label = domainReviewStatusLabels[value as DomainReviewStatus];
  return includeRaw ? `${label} (${value})` : label;
}
export function domainReviewSafeError(error: unknown, prefixes: readonly string[]) {
  const known = isAppError(error) ? error : undefined;
  const requestId = known?.requestId;
  // ApiClient contract/HTTP errors can carry the complete raw response. Never
  // retain those messages, codes, details or causes in this feature's state/cache.
  return new AppError("도메인 검토 요청을 확인하지 못했습니다.", {
    kind: known?.kind ?? "network",
    status: known?.status,
    requestId: requestId && !containsPotentialSecret(requestId, prefixes) ? requestId : undefined,
  });
}
export function domainReviewShortID(value: string, prefixes: readonly string[]) {
  return containsPotentialSecret(value, prefixes) ? domainReviewProtected : shortId(value);
}
export function domainReviewProblem(item: RoutingDomainReviewItem, prefixes: readonly string[]) {
  if (!domainReviewAddressableID(item.id) || containsPotentialSecret(item.id, prefixes))
    return "안전하게 지정할 수 있는 검토 ID가 없어 상태를 기록할 수 없습니다.";
  if (item.status !== "pending") return "검토 대기 항목에서만 상태 기록을 시작할 수 있습니다.";
  return undefined;
}
export function domainReviewSource(
  item: RoutingDomainReviewItem,
  action: DomainReviewAction,
  status: DomainReviewStatus,
): DomainReviewSource {
  return Object.freeze({ item: Object.freeze({ ...item }), action, status });
}
export function sameDomainReview(a: RoutingDomainReviewItem, b: RoutingDomainReviewItem) {
  return domainReviewFields.every(([field]) => a[field] === b[field]);
}
export function currentDomainReview(source: DomainReviewSource, report: RoutingDomainReviewReport) {
  const matches = report.items.filter((item) => item.id === source.item.id);
  const item = matches[0];
  return matches.length === 1 && item?.status === "pending" && sameDomainReview(source.item, item)
    ? item
    : undefined;
}
