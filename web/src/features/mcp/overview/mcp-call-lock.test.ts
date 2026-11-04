import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsMcpCallLock, withMcpCallLock } from "./mcp-call-lock";

afterEach(() => vi.unstubAllGlobals());

describe("MCP 탭 간 호출 잠금", () => {
  it("지원하지 않으면 실행하지 않는다", async () => {
    vi.stubGlobal("navigator", {});
    const operation = vi.fn();
    expect(supportsMcpCallLock()).toBe(false);
    await expect(withMcpCallLock(operation)).rejects.toMatchObject({ code: "mcp_call_lock_unavailable" });
    expect(operation).not.toHaveBeenCalled();
  });
  it("다른 탭이 보유한 잠금은 대기하거나 실행하지 않는다", async () => {
    const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
      callback(null),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const operation = vi.fn();
    await expect(withMcpCallLock(operation)).rejects.toMatchObject({ code: "mcp_call_in_progress" });
    expect(operation).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "vibe:app:mcp-test-call",
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    );
  });
  it("잠금 콜백이 전체 실행 완료까지 기다리고 결과를 전달한다", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
      callback({ name: "vibe:app:mcp-test-call", mode: "exclusive" }),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const operation = vi.fn(() => pending);
    let finished = false;
    const result = withMcpCallLock(operation).then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    release("완료");
    await expect(result).resolves.toBe("완료");
  });
  it("잠금 API 거부를 우회하여 호출하지 않는다", async () => {
    vi.stubGlobal("navigator", { locks: { request: vi.fn().mockRejectedValue(new Error("unavailable")) } });
    const operation = vi.fn();
    await expect(withMcpCallLock(operation)).rejects.toThrow("unavailable");
    expect(operation).not.toHaveBeenCalled();
  });
});
