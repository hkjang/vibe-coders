import type { BadgeProps } from "@/shared/components/ui/Badge";

type Tone = NonNullable<BadgeProps["tone"]>;

const lower = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/** Case decision (`pass` … `critical`) as the legacy screen labelled it. */
export const decisionLabels: Readonly<Record<string, string>> = {
  pass: "통과",
  warning: "경고",
  fail: "실패",
  critical: "치명",
  inconclusive: "판정 불가",
};

export function decisionLabel(value: string | undefined): string {
  return decisionLabels[lower(value)] ?? (value || "—");
}

export function decisionTone(value: string | undefined): Tone {
  switch (lower(value)) {
    case "critical":
    case "fail":
      return "danger";
    case "warning":
      return "warning";
    case "pass":
      return "success";
    default:
      return "muted";
  }
}

/** Severity / risk level of a target, pack or case. */
export function riskTone(value: string | undefined): Tone {
  switch (lower(value)) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    default:
      return "muted";
  }
}

const statusLabels: Readonly<Record<string, string>> = {
  draft: "초안",
  pending: "대기",
  approved: "승인됨",
  running: "실행 중",
  passed: "통과",
  completed: "완료",
  stopped: "중단",
  failed: "실패",
  warning: "경고",
  critical: "치명",
  rejected: "거절됨",
  blocked: "차단됨",
  error: "오류",
};

export function statusLabel(value: string | undefined): string {
  return statusLabels[lower(value)] ?? (value || "확인 필요");
}

export function stopReasonLabel(value: string): string {
  const reasons: Readonly<Record<string, string>> = {
    recording_failed: "실행 결과 저장을 확인하지 못했습니다",
    configuration_changed: "제공자 또는 실행 설정이 바뀌었습니다",
    model_unavailable: "검토한 모델을 호출할 수 없습니다",
    budget_exceeded: "비용 중단 기준에 도달했습니다",
    kill_switch: "긴급 중지가 적용되었습니다",
    call_limit: "실제 호출 횟수 한도에 도달했습니다",
    context_cancelled: "요청 연결 또는 실행 대기가 취소되었습니다",
    cost_unavailable: "호출 비용을 확인할 수 없습니다",
  };
  return reasons[lower(value)] ?? "서버가 실행 중단을 보고했습니다";
}

/** Campaign and run lifecycle status. */
export function statusTone(value: string | undefined): Tone {
  const normalized = lower(value);
  if (["failed", "critical", "rejected", "blocked", "error", "stopped"].includes(normalized)) {
    return "danger";
  }
  if (["warning", "pending", "draft", "running"].includes(normalized)) return "warning";
  if (["passed", "approved", "completed"].includes(normalized)) return "success";
  return "muted";
}

/** Risk score buckets match the server's run grading (>=65 fail, >=25 warn). */
export function scoreTone(score: number): Tone {
  if (score >= 65) return "danger";
  if (score >= 25) return "warning";
  return "muted";
}

export const remediationStatusLabels: Readonly<Record<string, string>> = {
  open: "조치 대기",
  in_progress: "조치중",
  resolved: "조치됨",
  dismissed: "기각",
};

export function remediationLabel(value: string | undefined): string {
  return remediationStatusLabels[lower(value) || "open"] ?? (value || "—");
}

export function remediationTone(value: string | undefined): Tone {
  const normalized = lower(value) || "open";
  return normalized === "resolved" || normalized === "dismissed" ? "success" : "warning";
}

export function isRemediationClosed(value: string | undefined): boolean {
  const normalized = lower(value) || "open";
  return normalized === "resolved" || normalized === "dismissed";
}

export const campaignScopes = [
  { value: "all", label: "전체" },
  { value: "provider", label: "프로바이더/모델" },
  { value: "mcp", label: "MCP" },
  { value: "text2sql", label: "Text2SQL" },
  { value: "ai_app", label: "AI 앱" },
  { value: "workflow", label: "워크플로" },
] as const;

export const executionModes = [
  { value: "dry-run", label: "드라이런(호출 없음)" },
  { value: "shadow", label: "섀도우" },
  { value: "active-controlled", label: "실제 실행(통제)" },
  { value: "pre-release", label: "릴리즈 전" },
  { value: "post-change", label: "변경 후" },
] as const;

export const destructivePolicies = [
  { value: "dry-run", label: "드라이런" },
  { value: "mock", label: "모의(mock)" },
  { value: "approval", label: "승인 필요" },
  { value: "block", label: "차단" },
] as const;

export const expectedPolicies = [
  "safe_completion",
  "refuse",
  "block",
  "mask",
  "approval_required",
  "no_tool_call",
  "limit_or_warning",
  "allow",
] as const;

export const evaluatorTypes = ["rule", "tool_call", "judge", "sql", "cost", "policy", "header"] as const;

export const severityLevels = ["low", "medium", "high", "critical"] as const;

export const cronPresets = [
  { value: "@daily", label: "매일(@daily)" },
  { value: "@hourly", label: "매시간(@hourly)" },
  { value: "@weekly", label: "매주(@weekly)" },
  { value: "every:6h", label: "6시간마다" },
  { value: "every:30m", label: "30분마다" },
] as const;

export const writeDeniedReason = "쓰기 권한(admin:write)이 없어 사용할 수 없습니다.";

export function recordingStageLabel(stage: string | undefined): string {
  const labels: Readonly<Record<string, string>> = {
    run_start: "대상별 실행 기록 생성",
    case_result: "검사 결과·증적·조치 저장",
    finalize: "실행·캠페인 상태와 기준선 갱신",
  };
  return labels[stage ?? ""] ?? "저장 확인";
}
