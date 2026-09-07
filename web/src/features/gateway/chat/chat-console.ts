import type { ChatTestTarget } from "@/shared/api/domains/gateway.schemas";
import { isSafeLegacyProviderName } from "@/shared/api/provider-ref";

export const maxCompareModels = 5;

export interface CompareModelSpec {
  model: string;
  provider?: string;
}

/**
 * Parses the legacy "model:provider" lines of the comparison editor. Blank lines are
 * ignored, duplicates collapse, and the server-side cap is applied here so the
 * operator sees the limit before a real (billable) run starts.
 */
export function parseCompareModels(raw: string): { models: CompareModelSpec[]; overflow: number } {
  const seen = new Set<string>();
  const models: CompareModelSpec[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.lastIndexOf(":");
    const model = separator > 0 ? trimmed.slice(0, separator).trim() : trimmed;
    const provider = separator > 0 ? trimmed.slice(separator + 1).trim() : "";
    if (model === "") continue;
    const key = `${model}|${provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(provider === "" ? { model } : { model, provider });
  }
  return {
    models: models.slice(0, maxCompareModels),
    overflow: Math.max(0, models.length - maxCompareModels),
  };
}

export const chatTargetGroupLabels: Readonly<Record<string, string>> = {
  routing: "라우팅",
  provider: "공급자",
  text2sql: "Text2SQL",
  mcp: "MCP",
};

export interface ChatTargetOption {
  value: string;
  label: string;
  group: string;
  target: ChatTestTarget;
}

/**
 * Turns the target catalogue into select options. Provider names arrive from the
 * legacy API unprojected, so an unsafe name is replaced by a neutral label rather
 * than rendered.
 */
export function chatTargetOptions(
  grouped: Readonly<Record<string, readonly ChatTestTarget[]>> | null | undefined,
  flat: readonly ChatTestTarget[],
): ChatTargetOption[] {
  const options: ChatTargetOption[] = [];
  const push = (group: string, target: ChatTestTarget): void => {
    const provider = target.provider ?? "";
    const safeLabel =
      provider !== "" && !isSafeLegacyProviderName(provider) ? "공급자 이름 비공개" : target.label;
    options.push({
      value: target.id,
      label: `${safeLabel}${target.enabled === false ? " · 비활성" : ""}`,
      group: chatTargetGroupLabels[group] ?? group,
      target,
    });
  };
  if (grouped) {
    for (const [group, targets] of Object.entries(grouped)) {
      for (const target of targets) push(group, target);
    }
    if (options.length > 0) return options;
  }
  for (const target of flat) push(target.kind, target);
  return options;
}

export const chatStatusLabels: Readonly<Record<string, string>> = {
  success: "성공",
  error: "실패",
  timeout: "시간 초과",
  ok: "성공",
};

export function chatStatusLabel(status: string | null | undefined): string {
  return chatStatusLabels[status ?? ""] ?? status ?? "-";
}

export const judgeVerdictLabels: Readonly<Record<string, string>> = {
  pass: "합격",
  warn: "주의",
  fail: "불합격",
};

export const riskLabels: Readonly<Record<string, string>> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
  none: "없음",
};

/** A model id is operator-supplied text, so keep it out of any markup we build. */
export function safeModelLabel(model: string | null | undefined): string {
  const value = (model ?? "").trim();
  if (value === "") return "모델 미지정";
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}
