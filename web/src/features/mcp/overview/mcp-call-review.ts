import type { z } from "zod";
import { mcpRouteExplainSchema as callExplanationSchema } from "@/shared/api/domains/mcp.schemas";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const callMethods = [
  { value: "tools/call", label: "도구 호출 (tools/call)" },
  { value: "prompts/get", label: "프롬프트 조회 (prompts/get)" },
  { value: "resources/read", label: "리소스 읽기 (resources/read)" },
  { value: "tools/list", label: "도구 목록 연결 점검 (tools/list)" },
];
export interface CallDraft {
  method: string;
  name: string;
  uri: string;
  arguments: string;
}
export const emptyCall: CallDraft = { method: "tools/call", name: "", uri: "", arguments: "{}" };
export interface CallInput {
  method: string;
  name: string;
  uri: string;
}
export interface CallCommand {
  input: CallInput;
  arguments: Record<string, unknown>;
}
export class CallDraftError extends Error {
  constructor(
    message: string,
    readonly field: keyof CallDraft,
  ) {
    super(message);
  }
}

export function callCommand(draft: CallDraft, prefixes: readonly string[]): CallCommand {
  if (!callMethods.some(({ value }) => value === draft.method))
    throw new CallDraftError("지원하는 메서드를 선택하세요.", "method");
  const input = { method: draft.method, name: draft.name.trim(), uri: draft.uri.trim() };
  if (input.method === "resources/read") {
    input.name = "";
    if (!input.uri) throw new CallDraftError("리소스 URI를 입력하세요.", "uri");
  } else {
    input.uri = "";
    if (!input.name)
      throw new CallDraftError(
        "노출 이름을 입력하세요. 연결 점검도 대상 서버를 찾을 이름이 필요합니다.",
        "name",
      );
  }
  if ([input.name, input.uri].some((value) => containsPotentialSecret(value, prefixes)))
    throw new CallDraftError(
      "이름과 URI에서 인증정보를 제거하세요.",
      input.method === "resources/read" ? "uri" : "name",
    );
  const hasArguments = input.method === "tools/call" || input.method === "prompts/get";
  const raw = hasArguments ? draft.arguments.trim() || "{}" : "{}";
  if (new TextEncoder().encode(raw).length > 16_384)
    throw new CallDraftError("JSON 인수는 16KB 이하여야 합니다.", "arguments");
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    throw new CallDraftError("올바른 JSON 객체를 입력하세요.", "arguments");
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new CallDraftError("인수는 JSON 객체여야 합니다.", "arguments");
  if (containsPotentialSecret(raw, prefixes))
    throw new CallDraftError("JSON 인수에서 인증정보를 제거하세요.", "arguments");
  return { input, arguments: args as Record<string, unknown> };
}

// The review cannot treat a missing/ill-typed decision as permission to execute.
export type CallExplanation = z.infer<typeof callExplanationSchema>;
export function checkedExplanation(value: unknown, input: CallInput): CallExplanation {
  const parsed = callExplanationSchema.safeParse(value);
  if (
    !parsed.success ||
    ["method", "name", "uri"].some((key) => parsed.data.input[key] !== input[key as keyof CallInput])
  )
    throw new AppError("경로 확인 응답을 검증하지 못했습니다.", { kind: "contract" });
  return parsed.data;
}
export const callable = (value: CallExplanation) =>
  value.route.found && ["allow", "warn"].includes(value.final.decision);

export function callReason(reason: string, prefixes: readonly string[]): string {
  const known: Record<string, string> = {
    "route not found for method/name/uri": "메서드와 이름 또는 URI에 맞는 경로가 없습니다.",
    "route found and policy allows call": "경로를 찾았고 현재 정책이 호출을 허용합니다.",
    "tool risk profile blocks call": "도구 위험 설정이 호출을 차단합니다.",
    "tool risk profile requires approval": "도구 위험 설정에 따라 승인이 필요합니다.",
    "server policy warns but allows call": "서버 정책이 경고와 함께 호출을 허용합니다.",
  };
  if (Object.hasOwn(known, reason)) return known[reason] ?? "—";
  if (reason.startsWith("server policy blocked:")) return "현재 서버 정책이 호출을 차단합니다.";
  if (containsPotentialSecret(reason, prefixes))
    return "인증정보로 보이는 내용이 있어 근거 원문을 숨겼습니다.";
  return reason || "제공 안 됨";
}
export function explanationFingerprint(value: CallExplanation): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
