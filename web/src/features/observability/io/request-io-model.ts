import type { RequestIOMessage, RequestIOPreview } from "@/shared/api/domains/observability.schemas";

const roleLabels: Readonly<Record<string, string>> = {
  system: "시스템",
  developer: "개발자",
  user: "사용자",
  assistant: "어시스턴트",
  tool: "도구",
  function: "도구",
  input: "입력",
};

export function requestIORoleLabel(role: string): string {
  return roleLabels[role.toLowerCase()] ?? (role || "역할 미상");
}

const finishLabels: Readonly<Record<string, string>> = {
  stop: "정상 완료",
  end_turn: "정상 완료",
  completed: "정상 완료",
  length: "길이 제한으로 중단",
  max_tokens: "길이 제한으로 중단",
  tool_calls: "도구 호출",
  function_call: "도구 호출",
  tool_use: "도구 호출",
  content_filter: "콘텐츠 필터로 중단",
  client_disconnected: "클라이언트가 연결을 끊음",
};

export function requestIOFinishLabel(reason: string): string {
  return finishLabels[reason.toLowerCase()] ?? reason;
}

export function requestIOFinishTone(reason: string): "danger" | "muted" | "success" | "warning" {
  const key = reason.toLowerCase();
  if (key === "") return "muted";
  if (["length", "max_tokens", "content_filter", "client_disconnected"].includes(key)) return "warning";
  return "success";
}

export function requestStatusTone(status: number): "danger" | "muted" | "success" | "warning" {
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  if (status === 0) return "muted";
  return "success";
}

/** Pretty-printed JSON when the whole text is a JSON object or array, otherwise undefined. */
export function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
    return undefined;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return undefined;
  }
}

export interface RequestIOTextSegment {
  kind: "text" | "code";
  value: string;
  language?: string;
}

/** Splits text on Markdown code fences so code stays monospaced. Everything renders as plain text. */
export function splitCodeFences(text: string): readonly RequestIOTextSegment[] {
  const segments: RequestIOTextSegment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/gu;
  let cursor = 0;
  // The code block already sets itself apart, so the newlines around it would only add gaps.
  const pushText = (value: string): void => {
    const trimmed = value.replace(/^\n+|\n+$/gu, "");
    if (trimmed) segments.push({ kind: "text", value: trimmed });
  };
  for (const match of text.matchAll(fence)) {
    if (match.index > cursor) pushText(text.slice(cursor, match.index));
    const language = match[1]?.trim();
    segments.push({
      kind: "code",
      value: (match[2] ?? "").replace(/\n$/u, ""),
      ...(language ? { language } : {}),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return [{ kind: "text", value: text }];
  if (cursor < text.length) pushText(text.slice(cursor));
  return segments;
}

export interface RequestIOConversation {
  instructions: readonly RequestIOMessage[];
  earlier: readonly RequestIOMessage[];
  latest: readonly RequestIOMessage[];
}

/**
 * Reads a conversation the way an operator does: the standing instructions, the turn this
 * request actually asked (the last user message and anything after it), and the earlier
 * turns that only give it context.
 */
export function splitConversation(messages: readonly RequestIOMessage[]): RequestIOConversation {
  const isInstruction = (message: RequestIOMessage): boolean =>
    ["system", "developer"].includes(message.role.toLowerCase());
  const instructions = messages.filter(isInstruction);
  const turns = messages.filter((message) => !isInstruction(message));
  let lastUser = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const role = turns[index]?.role.toLowerCase();
    if (role === "user" || role === "input") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return { instructions, earlier: [], latest: turns };
  return { instructions, earlier: turns.slice(0, lastUser), latest: turns.slice(lastUser) };
}

/** A preview is one running line, where a code fence's markers would only read as noise. */
function previewLine(text: string): string {
  return text.replace(/```[^\s`]*\s?/gu, "").trim();
}

export interface RequestIOOutputSummary {
  text: string;
  tone: "danger" | "default" | "muted";
}

/** One line for a list row. Says why there is no text rather than leaving a blank. */
export function outputSummary(preview: RequestIOPreview | undefined, status: number): RequestIOOutputSummary {
  if (!preview) return { text: "미리보기 없음", tone: "muted" };
  const { output } = preview;
  const tools = output.tool_names.length > 0 ? `도구 호출: ${output.tool_names.join(", ")}` : "";
  if (output.state === "captured") {
    const text = previewLine(output.text);
    if (output.kind === "error") return { text, tone: "danger" };
    if (output.kind === "tool_calls") return { text: tools || "도구 호출", tone: "default" };
    return { text: tools && text ? `${text} · ${tools}` : text, tone: "default" };
  }
  if (output.state === "not_captured") {
    if (tools) return { text: `${tools} (응답 본문 미저장)`, tone: "muted" };
    return status >= 400
      ? { text: `HTTP ${status} 오류 (응답 본문 미저장)`, tone: "danger" }
      : { text: "응답 본문 미저장", tone: "muted" };
  }
  return status >= 400
    ? { text: `HTTP ${status} · 응답 기록 없음`, tone: "danger" }
    : { text: "응답 기록 없음", tone: "muted" };
}

export function inputSummary(preview: RequestIOPreview | undefined): RequestIOOutputSummary {
  if (!preview) return { text: "미리보기 없음", tone: "muted" };
  if (preview.input.state !== "captured") return { text: "입력 기록 없음", tone: "muted" };
  const text = previewLine(preview.input.text);
  return { text: text || "내용 없는 메시지", tone: text ? "default" : "muted" };
}
