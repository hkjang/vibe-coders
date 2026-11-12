import type { z } from "zod";
import type { meSessionsSchema } from "@/shared/api/domains/me-access.schemas";
import { meError, validMePathID, validMeText } from "./me-console-model";

export const connectionClients = [
  { value: "openai-sdk", label: "OpenAI 호환 SDK" },
  { value: "cursor", label: "Cursor · MCP" },
  { value: "roo", label: "Roo · MCP" },
  { value: "cline", label: "Cline · MCP" },
  { value: "claude-desktop-mcp", label: "Claude Desktop · MCP" },
  { value: "claude", label: "Claude · MCP" },
  { value: "mcp", label: "일반 MCP 도구" },
] as const;
export type ConnectionClient = (typeof connectionClients)[number]["value"];
export const connectionClient = (value: string | null) =>
  connectionClients.find((client) => client.value === value)?.value ?? "openai-sdk";
export const doctorStatus = { pass: "정상", warn: "주의", fail: "실패", skip: "검사 안 함" } as const;
export const doctorCheckLabel = (name: string) =>
  (
    ({
      authorization: "인증",
      issued_keys: "발급 키 확인",
      scope: "권한",
      model_allowlist: "모델 허용 범위",
      quota: "사용 한도",
      v1_models: "모델 목록 연결",
      mcp_initialize: "MCP 연결",
      mcp_tools_list: "MCP 도구 목록",
      endpoint_reachability: "실제 연결 확인",
    }) as Readonly<Record<string, string>>
  )[name] ?? name;
export type PersonalSessions = z.output<typeof meSessionsSchema>;
export function currentSessionKnown(data: PersonalSessions | undefined) {
  return Boolean(
    data?.current_session_id &&
    data.sessions.some((row) => row.id === data.current_session_id && row.current === true),
  );
}
export function sessionReview(data: PersonalSessions) {
  return JSON.stringify([data.current_session_id, data.sessions.map((row) => row.id).sort()]);
}
export function requireSessionTarget(data: PersonalSessions, id: string, prefixes: readonly string[]) {
  if (
    !currentSessionKnown(data) ||
    !validMePathID(id, prefixes) ||
    id === data.current_session_id ||
    !data.sessions.some((row) => row.id === id && row.current === false)
  )
    throw meError("changed");
}
export function connectionURLs(base: string, mcp: string, prefixes: readonly string[]) {
  const parse = (value: string, path: string) => {
    if (!validMeText(value, prefixes, 2048) || /[\\\s'"`<>]/u.test(value)) throw meError();
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== path
    )
      throw meError();
    return url;
  };
  const baseURL = parse(base, "/v1"),
    mcpURL = parse(mcp, "/mcp/gateway");
  if (baseURL.origin !== mcpURL.origin) throw meError();
  return { baseURL: baseURL.href, mcpURL: mcpURL.href };
}
export function connectionExamples(baseURL: string, mcpURL: string) {
  const sdk = `from openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(baseURL)},\n    api_key="<YOUR_API_KEY>",\n)\n# model: "vibe/auto"`;
  const mcp = JSON.stringify(
    { mcpServers: { "vibe-gateway": { url: mcpURL, headers: { Authorization: "Bearer <YOUR_API_KEY>" } } } },
    null,
    2,
  );
  return { sdk, mcp };
}
