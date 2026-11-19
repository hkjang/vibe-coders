import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadApiFile } from "@/shared/api/download-file";
import { AppError } from "@/shared/api/error";

const allocate = vi.fn<(blob: Blob) => string>();
const revoke = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  allocate.mockReset().mockReturnValue("blob:owned-export");
  revoke.mockReset();
  vi.stubGlobal("URL", { createObjectURL: allocate, revokeObjectURL: revoke });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function file(assertCurrent = () => {}) {
  return {
    bytes: new TextEncoder().encode(' {"large":9007199254740993,"name":"공개 합성 자료"}\n').buffer,
    contentType: "application/json; charset=utf-8",
    assertCurrent,
  };
}

describe("owned exact-byte download", () => {
  it("preserves source bytes, removes the anchor and revokes the delivered URL", async () => {
    const input = file();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("fixture.json");
      expect(this.getAttribute("href")).toBe("blob:owned-export");
    });
    downloadApiFile("fixture.json", input);
    const blob = allocate.mock.calls[0]?.[0];
    expect(blob?.type).toBe("application/json; charset=utf-8");
    if (!blob) throw new Error("download did not allocate a blob");
    const loaded = new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download="fixture.json"]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(new Uint8Array(await loaded)).toEqual(new Uint8Array(input.bytes));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-export");
  });

  it.each([1, 3, 4])(
    "does not click and releases resources when ownership retires at guard %s",
    (retireAt) => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      let checks = 0;
      expect(() =>
        downloadApiFile(
          "fixture.json",
          file(() => {
            if (++checks === retireAt) throw new AppError("retired", { kind: "aborted" });
          }),
        ),
      ).toThrowError(expect.objectContaining({ kind: "aborted" }));
      expect(click).not.toHaveBeenCalled();
      expect(document.querySelector('a[download="fixture.json"]')).toBeNull();
      if (retireAt === 1) expect(allocate).not.toHaveBeenCalled();
      else expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-export");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("removes the anchor and revokes immediately if browser dispatch fails", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("dispatch failed");
    });
    expect(() => downloadApiFile("fixture.json", file())).toThrow("dispatch failed");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-export");
    expect(document.querySelector('a[download="fixture.json"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
