import { AppError } from "@/shared/api/error";
import { endpoints } from "@/shared/api/endpoints";
import type { ChatTestRunBody } from "@/shared/api/domains/gateway";
import { tokenStore } from "@/shared/auth/token-store";

export interface ChatStreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatStreamHandlers {
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: ChatStreamUsage) => void;
  onHeaders?: (headers: Readonly<Record<string, string>>) => void;
}

export interface ChatStreamOutcome {
  content: string;
  reasoning: string;
  finishReason: string;
  statusCode: number;
  usage: ChatStreamUsage;
  headers: Readonly<Record<string, string>>;
}

interface StreamChunkDelta {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
}

interface StreamChunk {
  choices?: ReadonlyArray<{ delta?: StreamChunkDelta; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  error?: { message?: unknown };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Diagnostic response headers only; anything else could carry upstream credentials. */
function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower.includes("key") || lower.includes("token")) return;
    if (lower.startsWith("x-") || lower === "content-type") headers[key] = value;
  });
  return headers;
}

function streamAuthHeaders(): Headers {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "X-Vibe-UI": "app",
    "X-Vibe-Route": "gateway.chat",
  });
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/**
 * Runs one chat-test call as Server-Sent Events. The console reads the body with
 * `fetch` + `ReadableStream` (rather than `apiClient`) so tokens render as they
 * arrive and the operator can cancel mid-answer through `signal`.
 */
export async function streamChatTest(
  body: ChatTestRunBody,
  handlers: ChatStreamHandlers = {},
  signal?: AbortSignal,
): Promise<ChatStreamOutcome> {
  const assertReceiving = (received?: Response) => {
    if (signal?.aborted) {
      void received?.body?.cancel().catch(() => undefined);
      throw new AppError("응답 수신을 중단했습니다.", { kind: "aborted" });
    }
  };
  assertReceiving();
  let response: Response;
  try {
    response = await fetch(endpoints.domains.gateway.chat.stream.path, {
      method: endpoints.domains.gateway.chat.stream.method,
      headers: streamAuthHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new AppError("응답 수신을 중단했습니다.", { kind: "aborted", cause });
    throw new AppError("게이트웨이에 연결할 수 없습니다.", { kind: "network", retryable: true, cause });
  }

  assertReceiving(response);

  const headers = collectHeaders(response);
  handlers.onHeaders?.(headers);
  assertReceiving(response);
  const requestId = response.headers.get("X-Request-ID") ?? undefined;

  if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("event-stream")) {
    const raw = await response.text();
    let message = response.ok ? "스트리밍 응답을 받지 못했습니다." : `HTTP ${response.status}`;
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      ) {
        message = parsed.error.message;
      }
    } catch {
      // Non-JSON body: keep the status-derived message rather than echoing raw text.
    }
    if (response.ok) {
      // A buffered JSON answer is still a usable result for the operator.
      throw new AppError(message, { kind: "contract", status: response.status, requestId });
    }
    throw new AppError(message, {
      kind: response.status === 401 ? "auth" : response.status === 403 ? "permission" : "http",
      status: response.status,
      requestId,
      retryable: response.status >= 500,
    });
  }

  const outcome: ChatStreamOutcome = {
    content: "",
    reasoning: "",
    finishReason: "",
    statusCode: response.status,
    usage: {},
    headers,
  };
  const reader = response.body?.getReader();
  if (!reader) return outcome;

  const decoder = new TextDecoder();
  let buffer = "";

  const consumeEvent = (block: string): void => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const content = textOf(choice?.delta?.content);
      if (content) {
        outcome.content += content;
        handlers.onContent?.(content);
      }
      const reasoning = textOf(choice?.delta?.reasoning_content) || textOf(choice?.delta?.reasoning);
      if (reasoning) {
        outcome.reasoning += reasoning;
        handlers.onReasoning?.(reasoning);
      }
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        outcome.finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        outcome.usage = {
          promptTokens: countOf(chunk.usage.prompt_tokens),
          completionTokens: countOf(chunk.usage.completion_tokens),
          totalTokens: countOf(chunk.usage.total_tokens),
        };
        handlers.onUsage?.(outcome.usage);
      }
    }
  };

  // Cancel only the browser reader. This is not a server execution/cost rollback.
  const stopReading = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", stopReading, { once: true });
  if (signal?.aborted) stopReading();
  try {
    assertReceiving();
    for (;;) {
      const { done, value } = await reader.read();
      assertReceiving();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        consumeEvent(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim() !== "") consumeEvent(buffer);
  } catch (cause) {
    if (signal?.aborted) throw new AppError("응답 수신을 중단했습니다.", { kind: "aborted", cause });
    throw new AppError("스트리밍 응답을 읽는 중 오류가 발생했습니다.", { kind: "network", cause });
  } finally {
    signal?.removeEventListener("abort", stopReading);
    reader.releaseLock();
  }
  return outcome;
}
