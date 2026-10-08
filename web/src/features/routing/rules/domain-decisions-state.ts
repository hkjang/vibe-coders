import type {
  RoutingDomainDecision,
  RoutingDomainDecisionReport,
  RoutingDomainSignal,
} from "@/shared/api/domains/routing-domain-decisions";
import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { shortId } from "@/shared/utils/format";

export const domainDecisionProtected = "민감정보가 포함될 수 있어 표시하지 않습니다.";
export const domainDecisionPermission =
  "도메인 결정 로그는 routing:read와 프롬프트 원문 조회 권한이 있는 계정만 볼 수 있습니다.";
export const domainDecisionDenied =
  "로그인 상태와 routing:read·프롬프트 원문 조회 권한을 확인하고, 필요하면 다시 로그인한 뒤 결정 목록을 다시 조회하세요. 이전 결과와 선택한 근거는 표시하지 않습니다.";
export const domainDecisionChanged = "조회 기준이 바뀌었습니다. 현재 목록에서 결정 근거를 다시 선택하세요.";

export function domainDecisionText(value: string, prefixes: readonly string[], empty = "없음") {
  return containsPotentialSecret(value, prefixes) ? domainDecisionProtected : value || empty;
}

export function domainDecisionShortID(value: string, prefixes: readonly string[]) {
  return containsPotentialSecret(value, prefixes) ? domainDecisionProtected : shortId(value) || "빈 ID";
}

export function domainDecisionSafeError(error: unknown, prefixes: readonly string[]) {
  const known = isAppError(error) ? error : undefined;
  const requestId = known?.requestId;
  return new AppError("도메인 결정 목록을 확인하지 못했습니다.", {
    kind: known?.kind ?? "network",
    status: known?.status,
    requestId: requestId && !containsPotentialSecret(requestId, prefixes) ? requestId : undefined,
  });
}

const sourceLabels: Readonly<Record<string, string>> = {
  explicit_model: "명시 모델",
  selector: "선택기",
  mcp_evidence: "도구 증거",
  evidence_gate: "증거 기준",
};
export function domainDecisionSourceLabel(value: string, prefixes: readonly string[]) {
  return Object.hasOwn(sourceLabels, value)
    ? sourceLabels[value]
    : domainDecisionText(value, prefixes, "출처 없음");
}

export interface DomainDecisionSource {
  readonly item: Readonly<RoutingDomainDecision>;
  readonly signals: ReadonlyArray<Readonly<RoutingDomainSignal>> | null;
}
export function domainDecisionSource(
  item: RoutingDomainDecision,
  report: RoutingDomainDecisionReport,
): DomainDecisionSource {
  const signals = Object.hasOwn(report.signals, item.id) ? report.signals[item.id] : null;
  return Object.freeze({
    item: Object.freeze({ ...item, tool_names: [...item.tool_names] }),
    signals:
      signals === null || signals === undefined
        ? null
        : Object.freeze(signals.map((signal) => Object.freeze({ ...signal }))),
  });
}
