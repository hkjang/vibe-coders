import type { WorkActionId, WorkRequest } from "@/shared/api/domains/insights-common";
import type { AutomationReviewStatus, WorkSignalKind } from "@/shared/api/domains/insights-usage";

// Display names for the server's identifiers. Lookups fall back to the raw value,
// so an identifier this build does not know yet is still shown rather than hidden.

const label = (table: Readonly<Record<string, string>>, value: string, fallback = "—"): string =>
  (Object.hasOwn(table, value) ? table[value] : undefined) ?? (value || fallback);

export const actionLabels: Readonly<Record<WorkActionId, string>> = {
  read: "조회",
  analyze: "분석",
  create: "생성",
  modify: "수정",
  delete: "삭제",
  verify: "검증",
  plan: "계획",
  automate: "자동화",
  unknown: "미상",
};
export const actionLabel = (value: string): string => label(actionLabels, value);

export const signalKindLabels: Readonly<Record<WorkSignalKind, string>> = {
  rising_7d: "7일 급증",
  rising_30d: "30일 급증",
  new: "신규",
  team_concentrated: "특정 조직 집중",
  spreading: "확산",
  declining: "감소",
  cost_spike: "비용 이상",
  model_dependence: "모델 의존",
};
export const signalKindLabel = (value: string): string => label(signalKindLabels, value);

export const signalKindHints: Readonly<Record<WorkSignalKind, string>> = {
  rising_7d: "최근 7일 사용량이 그 전 7일보다 크게 늘어난 업무",
  rising_30d: "최근 30일 사용량이 그 전 30일보다 크게 늘어난 업무",
  new: "비교 기간에는 없다가 이번 기간에 처음 나타난 업무",
  team_concentrated: "사용량 대부분이 한 조직에서 나오는 업무",
  spreading: "쓰는 조직이나 사용자가 늘어나고 있는 업무",
  declining: "사용량이 눈에 띄게 줄어든 업무",
  cost_spike: "사용량에 비해 비용이 크게 늘어난 업무",
  model_dependence: "한 모델에 사용량이 몰린 업무",
};

const recommendedLabels = {
  prompt_template: "프롬프트 템플릿",
  skill: "스킬",
  mcp_tool: "MCP 도구",
  workflow: "워크플로",
  agent: "에이전트",
  batch: "배치 작업",
};
export const recommendedLabel = (value: string): string => label(recommendedLabels, value);

const riskLabels = { low: "낮음", medium: "보통", high: "높음" };
export const riskLabel = (value: string): string => label(riskLabels, value);
export const riskTone = (value: string): "muted" | "warning" | "danger" =>
  value === "high" ? "danger" : value === "medium" ? "warning" : "muted";

export const reviewStatusLabels: Readonly<Record<AutomationReviewStatus, string>> = {
  new: "신규",
  reviewing: "검토 중",
  accepted: "채택",
  dismissed: "제외",
};
export const reviewStatusLabel = (value: string): string => label(reviewStatusLabels, value);
export const reviewStatusTone = (value: string): "info" | "muted" | "success" | "warning" =>
  value === "accepted" ? "success" : value === "reviewing" ? "warning" : value === "new" ? "info" : "muted";

export const completionValues = ["unknown", "ended_with_error", "confirmed"] as const;
const completionLabels = {
  unknown: "완료 미확인",
  ended_with_error: "오류로 종료",
  confirmed: "완료 확인",
};
export const completionLabel = (value: string): string => label(completionLabels, value);
export const completionTone = (value: string): "danger" | "muted" | "success" =>
  value === "confirmed" ? "success" : value === "ended_with_error" ? "danger" : "muted";

const sessionKindLabels = { explicit: "클라이언트 지정", inferred: "추론", trace: "요청 단위" };
export const sessionKindLabel = (value: string): string => label(sessionKindLabels, value);

const classificationLabels = {
  classified: "분류 완료",
  review: "검토 필요",
  unclassified: "미분류",
  failed: "분류 실패",
};
export const classificationLabel = (value: string): string => label(classificationLabels, value);
export const classificationTone = (value: string): "danger" | "muted" | "success" | "warning" =>
  value === "classified"
    ? "success"
    : value === "review"
      ? "warning"
      : value === "failed"
        ? "danger"
        : "muted";

const methodLabels = { rule: "규칙", llm: "LLM", cache: "캐시", manual: "수동 보정" };
export const methodLabel = (value: string): string => label(methodLabels, value);

const severityLabels = { info: "참고", notice: "주목", warning: "주의" };
export const severityLabel = (value: string): string => label(severityLabels, value);
export const severityTone = (value: string): "info" | "muted" | "warning" =>
  value === "warning" ? "warning" : value === "notice" ? "info" : "muted";

/** Clients the gateway recognises from the User-Agent; the list a filter offers. */
export const knownClients = [
  "Claude Code",
  "Cursor",
  "Cline",
  "Roo Code",
  "Kilo Code",
  "Qwen Code",
  "Aider",
  "Continue",
  "OpenWebUI",
  "VS Code",
] as const;

export const unclassifiedExplanation =
  "미분류는 규칙과 캐시(그리고 켜져 있다면 LLM)로도 업무를 정하지 못한 요청입니다. 숨기지 않고 따로 집계합니다.";
export const failedExplanation =
  "분류 실패는 분류 모델 호출이 실패했고 규칙 결과도 없는 요청입니다. 재분류하면 줄어들 수 있습니다.";

export const automationDisclaimer =
  "후보는 반복 패턴에서 계산한 제안입니다. 검토 상태만 기록하며, 어떤 것도 자동으로 등록하거나 실행하지 않습니다.";

/** Deep link into the request explorer for one request (router path, without `/app`). */
export const requestExplorerPath = (requestId: string): string =>
  `/observability/requests?request_id=${encodeURIComponent(requestId)}`;

/**
 * A user value exactly as the server returned it. Empty means the server withheld
 * it (no pseudonym for a caller who may not see raw prompts): a dash, never a filter.
 */
export const userText = (user: string): string => user || "—";

/**
 * A request's work title. A caller who may not see raw prompts gets none (it is
 * derived from the prompt), so the category name stands in for it.
 */
export const workTitleText = (request: Pick<WorkRequest, "work_title" | "category">): string =>
  request.work_title || request.category.name || "—";

export const workTitleFallbackHint = "작업 제목이 없어 업무 이름을 대신 표시합니다.";

/** Why a whole panel is withheld: the scope is too small a group to show. */
export const withheldScopeText =
  "이 범위는 참여 사용자가 적어 세부 항목을 보여 주지 않습니다. 기간을 넓히거나 필터를 줄여 보세요.";

/** Why a chart draws nothing while its table lists withheld rows. */
export const withheldChartText =
  "그릴 수 있는 값이 없습니다. 사용자가 적어 가린 항목은 표에 ‘보호됨’으로 나옵니다.";

/** The overview's classification-quality distributions are not sent to a caller who may not see raw prompts. */
export const qualityWithheldNote = "분류 품질 분포는 프롬프트 원문 열람 권한이 있는 관리자에게만 보입니다.";
