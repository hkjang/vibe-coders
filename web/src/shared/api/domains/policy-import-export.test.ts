import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { readPolicyExport } from "./policy-import-export";
import { policyImportLimits } from "./policy-import-json";

const options = () => ({ signal: new AbortController().signal, assertCurrent: vi.fn() });
beforeEach(() => tokenStore.clearAll());
afterEach(() => vi.useRealTimers());
describe("생성 경로에 결속된 원문 내보내기 transport", () => {
  it("JSON 숫자/공백 bytes를 변환하지 않고 인증·UI 경로/no-store로 한 번 요청한다", async () => {
    const raw = ' {"future":9007199254740993}\n';
    tokenStore.setLegacyToken("public-synthetic-token");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(raw));
    const input = options();
    const result = await readPolicyExport(input);
    expect(new TextDecoder().decode(result)).toBe(raw);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/admin/policies/export",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer public-synthetic-token",
          "X-Vibe-Route": "governance.policies",
        }),
      }),
    );
    expect(input.assertCurrent.mock.calls.length).toBeGreaterThan(1);
  });
  it("401은 raw error본문을 읽거나 refresh/retry하지 않고 안전한 Request ID만 전달한다", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("RAW_BODY_DO_NOT_READ"));
      },
    });
    const response = new Response(body, { status: 401, headers: { "X-Request-ID": "public-request" } });
    const getReader = vi.spyOn(body, "getReader");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(readPolicyExport(options())).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      requestId: "public-request",
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("Content-Length 초과는 reader 전에 거절한다", async () => {
    const body = new ReadableStream<Uint8Array>();
    const getReader = vi.spyOn(body, "getReader");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { headers: { "Content-Length": String(policyImportLimits.bytes + 1) } }),
    );
    await expect(readPolicyExport(options())).rejects.toMatchObject({
      kind: "contract",
      message: expect.stringContaining("정식 운영 백업"),
    });
    expect(getReader).not.toHaveBeenCalled();
  });
  it.each([undefined, "1"])(
    "누락/거짓 Content-Length %s도 실제 decoded bytes 합으로 cap+cancel한다",
    async (length) => {
      const canceled = vi.fn();
      let count = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(++count === 1 ? policyImportLimits.bytes : 1));
        },
        cancel: canceled,
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(stream, { headers: length ? { "Content-Length": length } : {} }),
      );
      await expect(readPolicyExport(options())).rejects.toMatchObject({ kind: "contract" });
      expect(canceled).toHaveBeenCalledOnce();
    },
  );
  it("한도와 정확히 같은 bytes는 허용한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(policyImportLimits.bytes)));
    expect((await readPolicyExport(options())).byteLength).toBe(policyImportLimits.bytes);
  });
  it("현재 read 검사가 실패하면 네트워크를 시작하지 않는다", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      readPolicyExport({
        ...options(),
        assertCurrent: () => {
          throw new AppError("denied", { kind: "permission" });
        },
      }),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("epoch 또는 caller abort 뒤 늦은 fetch 응답을 폐기한다", async () => {
    for (const boundary of ["epoch", "abort"]) {
      let release: ((response: Response) => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      const controller = new AbortController();
      const operation = readPolicyExport({ signal: controller.signal, assertCurrent: () => {} });
      const denied = expect(operation).rejects.toMatchObject({ kind: "aborted" });
      if (boundary === "epoch") tokenStore.clearAll();
      else controller.abort();
      release?.(new Response("public"));
      await denied;
    }
  });
  it("15초 deadline 후 transport가 abort를 무시해도 성공 데이터를 반환하지 않는다", async () => {
    vi.useFakeTimers();
    let release: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const operation = readPolicyExport(options());
    const timedout = expect(operation).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(15000);
    release?.(new Response("public"));
    await timedout;
  });
});
