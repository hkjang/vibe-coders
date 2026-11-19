import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readChargebackCsv } from "./chargeback-csv";
import { endpoints } from "./endpoints";
import { tokenStore } from "@/shared/auth/token-store";

beforeEach(() => tokenStore.clearTokens());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  tokenStore.clearTokens();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("정산 CSV 전송 계약", () => {
  it("기존 경로·CSV 형식·동일 출처·인증 및 UI 헤더를 유지한다", async () => {
    tokenStore.saveTokens({ access_token: "public-test-access", refresh_token: "public-test-refresh" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("csv", { headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    expect(await readChargebackCsv("2026-10", new AbortController().signal)).toBe("csv");
    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/admin/cost/chargeback-pack?format=csv&month=2026-10");
    expect(options).toMatchObject({
      redirect: "error",
      credentials: "same-origin",
      method: "GET",
    });
    expect(Object.fromEntries(new Headers(options?.headers))).toMatchObject({
      accept: "text/csv",
      authorization: "Bearer public-test-access",
      "x-vibe-ui": "app",
      "x-vibe-route": "finops.overview",
    });
    expect(new Headers(options?.headers).has("X-Vibe-UI-Version")).toBe(true);
  });
  it.each(["", "2026-13", "2026-1", "2026-10&notify=1"])("잘못된 월 %s는 전송하지 않는다", async (month) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(readChargebackCsv(month, new AbortController().signal)).rejects.toMatchObject({
      kind: "contract",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(["application/json", "text/html", ""])(
    "CSV가 아닌 %s 응답을 저장 대상으로 반환하지 않는다",
    async (type) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("fixture", { headers: { "Content-Type": type, "X-Request-ID": "csv-type" } }),
      );
      await expect(readChargebackCsv("2026-10", new AbortController().signal)).rejects.toMatchObject({
        kind: "contract",
        requestId: "csv-type",
      });
    },
  );
  it("계정 변경 뒤 늦은 응답은 소비하지 않는다", async () => {
    const pending = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const result = readChargebackCsv("2026-10", new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ kind: "aborted" });
    tokenStore.clearTokens();
    pending.resolve(new Response("fixture", { headers: { "Content-Type": "text/csv" } }));
    await assertion;
  });
  it("취소 뒤 진행 중인 본문 reader를 취소하고 반환하지 않는다", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const read = vi.spyOn(stream, "getReader");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { headers: { "Content-Type": "text/csv" } }),
    );
    const controller = new AbortController();
    const result = readChargebackCsv("2026-10", controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ kind: "aborted" });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("헤더 뒤 본문 시간 제한 오류는 네트워크 오류와 구분한다", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "Content-Type": "text/csv", "X-Request-ID": "csv-deadline" },
      }),
    );
    const result = readChargebackCsv("2026-10", new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ kind: "timeout", requestId: "csv-deadline" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 500])("HTTP %i는 요청 ID를 유지하고 자동 재전송하지 않는다", async (status) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("private fixture", { status, headers: { "X-Request-ID": "csv-http" } }),
      );
    await expect(readChargebackCsv("2026-10", new AbortController().signal)).rejects.toMatchObject({
      kind: status === 401 ? "auth" : status === 403 ? "permission" : "http",
      status,
      requestId: "csv-http",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
describe("정산 JSON 오류 건수 어댑터", () => {
  it.each([
    { errors: 7, error_requests: 1, expected: 7 },
    { errors: 0, error_requests: 9, expected: 0 },
    { errors: "3", expected: 3 },
    { error_requests: 4, expected: 4 },
  ])("서버 errors를 우선하고 과거 필드도 수용한다: $expected", ({ expected, ...row }) => {
    const result = endpoints.domains.finops.chargebackPack.schema.parse({ dimensions: [{ rows: [row] }] });
    expect(result.dimensions[0]?.rows[0]?.error_requests).toBe(expected);
  });
});
