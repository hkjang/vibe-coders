import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatTest } from "./chat-stream";
import { controlledChatResponse, deferred } from "./chat-stream-test-support";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const body = { model: "public-model", messages: [{ role: "user", content: "public prompt" }] };

describe("브라우저 응답 수신 중단만 담당하는 SSE transport", () => {
  it("사전 중단 signal은 실제 fetch0", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(streamChatTest(body, {}, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("headers가 늦게 도착하면 중단된 응답은 읽지 않고 로컬 body만 정리한다", async () => {
    const gate = deferred<Response>(),
      stream = controlledChatResponse(),
      onHeaders = vi.fn();
    globalThis.fetch = vi.fn(() => gate.promise);
    const controller = new AbortController();
    const completion = streamChatTest(body, { onHeaders }, controller.signal);
    controller.abort();
    gate.resolve(stream.response);
    await expect(completion).rejects.toMatchObject({ kind: "aborted" });
    expect(onHeaders).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });
  it("대기 중인 reader를 수동 중단하면 cancel 후 lock을 해제하고 성공으로 표시하지 않는다", async () => {
    const stream = controlledChatResponse(),
      onContent = vi.fn(),
      onHeaders = deferred<undefined>();
    globalThis.fetch = vi.fn(async () => stream.response);
    const controller = new AbortController();
    const completion = streamChatTest(
      body,
      { onContent, onHeaders: () => onHeaders.resolve(undefined) },
      controller.signal,
    );
    await onHeaders.promise;
    stream.chunk("부분 응답");
    await Promise.resolve();
    controller.abort();
    await expect(completion).rejects.toMatchObject({ kind: "aborted" });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
    // A real gateway/provider is not present; no execution rollback is asserted.
  });
  it("정상 완료는 기존 content/reasoning/usage 형식을 유지하고 cancel하지 않는다", async () => {
    const stream = controlledChatResponse(),
      onHeaders = deferred<undefined>();
    globalThis.fetch = vi.fn(async () => stream.response);
    const completion = streamChatTest(body, { onHeaders: () => onHeaders.resolve(undefined) });
    await onHeaders.promise;
    stream.chunk("공개 답", "공개 추론", 8);
    stream.finish();
    await expect(completion).resolves.toMatchObject({
      content: "공개 답",
      reasoning: "공개 추론",
      usage: { totalTokens: 8 },
    });
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(stream.response.body?.locked).toBe(false);
  });
  it("401을 자동 재전송하거나 토큰 갱신하지 않고 기존 요청 ID를 전달한다", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "public denial" } }), {
          status: 401,
          headers: { "Content-Type": "application/json", "X-Request-ID": "req_public_401" },
        }),
    );
    globalThis.fetch = fetch;
    await expect(streamChatTest(body)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      requestId: "req_public_401",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
