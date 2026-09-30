import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMultiRunExport } from "./multi-run-export";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadText } from "@/shared/utils/csv";

vi.mock("@/shared/utils/csv", () => ({ downloadText: vi.fn() }));
const originalFetch = globalThis.fetch;
beforeEach(() => {
  tokenStore.clearAll();
  vi.mocked(downloadText).mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

describe("비교 결과 파일의 로컬 다운로드 경계", () => {
  it("정상 원문 조회는 기존 경로·헤더를 유지하고 파일을 한 번 내려받는다", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("public-export"));
    globalThis.fetch = fetch;
    const assertCurrent = vi.fn();
    await downloadMultiRunExport("public/run", "csv", { assertCurrent });
    expect(fetch).toHaveBeenCalledWith("/admin/chat-test/multi-run/runs/public%2Frun/export?format=csv", {
      headers: { "X-Vibe-UI": "app" },
    });
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    expect(downloadText).toHaveBeenCalledExactlyOnceWith(
      "multi-model-public/run.csv",
      "public-export",
      "text/csv;charset=utf-8",
    );
  });
  it("호출 전 owner/권한 guard가 거부하면 fetch0", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetch;
    await expect(
      downloadMultiRunExport("public-run", "md", {
        assertCurrent: () => {
          throw new AppError("public-denied", { kind: "permission" });
        },
      }),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(fetch).not.toHaveBeenCalled();
    expect(downloadText).not.toHaveBeenCalled();
  });
  it.each(["epoch", "owner", "aborted"])(
    "응답 전 %s 폐기는 원문 text 읽기와 다운로드를 막는다",
    async (boundary) => {
      const hold = deferred<Response>();
      globalThis.fetch = vi.fn(() => hold.promise);
      const response = new Response("old-public-export");
      const read = vi.spyOn(response, "text");
      const controller = new AbortController();
      let current = true;
      const result = downloadMultiRunExport("public-run", "md", {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw new AppError("old-owner", { kind: "aborted" });
        },
      });
      if (boundary === "epoch") tokenStore.clearAll();
      if (boundary === "owner") current = false;
      if (boundary === "aborted") controller.abort();
      hold.resolve(response);
      await expect(result).rejects.toMatchObject({ kind: "aborted" });
      expect(read).not.toHaveBeenCalled();
      expect(downloadText).not.toHaveBeenCalled();
    },
  );
  it.each(["epoch", "owner", "aborted"])(
    "본문 대기 중 %s 폐기는 늦은 다운로드를 막는다",
    async (boundary) => {
      const text = deferred<string>();
      const started = deferred<undefined>();
      const response = new Response();
      vi.spyOn(response, "text").mockImplementation(() => {
        started.resolve(undefined);
        return text.promise;
      });
      globalThis.fetch = vi.fn(async () => response);
      const controller = new AbortController();
      let current = true;
      const result = downloadMultiRunExport("public-run", "json", {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw new AppError("old-owner", { kind: "aborted" });
        },
      });
      await started.promise;
      if (boundary === "epoch") tokenStore.clearAll();
      if (boundary === "owner") current = false;
      if (boundary === "aborted") controller.abort();
      text.resolve("old-public-export");
      await expect(result).rejects.toMatchObject({ kind: "aborted" });
      expect(downloadText).not.toHaveBeenCalled();
    },
  );
  it("서버 권한 실패는 요청 ID를 유지하고 자동 refresh/retry/download를 만들지 않는다", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response("public-denied", { status: 403, headers: { "X-Request-ID": "req_public_export" } }),
      );
    globalThis.fetch = fetch;
    await expect(downloadMultiRunExport("public-run", "md")).rejects.toMatchObject({
      status: 403,
      requestId: "req_public_export",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(downloadText).not.toHaveBeenCalled();
  });
});
