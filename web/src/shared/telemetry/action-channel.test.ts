import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, type AppErrorKind } from "@/shared/api/error";
import { captureAction, installActionSink, observeAction, type ActionKind } from "./action-channel";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});
describe("explicit operation observations", () => {
  it("drops a retired operation even while the same authenticated sink remains active", async () => {
    const send = vi.fn();
    dispose = installActionSink(
      () => "gateway.providers",
      () => true,
      send,
    );
    let owned = true;
    const old = captureAction("save", undefined, () => owned);
    owned = false;
    old?.success();
    owned = true;
    old?.success();
    expect(send).not.toHaveBeenCalled();
    const abandoned = captureAction("delete", undefined, () => owned);
    owned = false;
    abandoned?.failure(new AppError("private", { kind: "http", status: 409 }));
    expect(send).not.toHaveBeenCalled();
    const assertOwner = () => {
      throw new Error("retired");
    };
    await expect(observeAction("save", async () => 42, assertOwner)).resolves.toBe(42);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not inspect variables before opt-in and excludes read-only actions", () => {
    const choose = vi.fn(() => "save" as const);
    expect(captureAction(choose, "private payload")).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
    const send = vi.fn();
    dispose = installActionSink(
      () => "overview",
      () => true,
      send,
    );
    expect(captureAction(false, undefined)).toBeUndefined();
    expect(captureAction("private name" as ActionKind, undefined)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("retains the origin feature, emits no input/result text and reports once per submission", async () => {
    const send = vi.fn();
    let feature = "gateway.providers";
    dispose = installActionSink(
      () => feature,
      () => true,
      send,
    );
    const completion = captureAction("save", { password: "private-secret" });
    feature = "overview";
    completion?.success();
    completion?.failure(new Error("private-message"));
    completion?.success();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "gateway.providers",
      action: "save",
      outcome: "success",
    });
    const result = { secret: "private-result" };
    await expect(observeAction("run_request", async () => result)).resolves.toBe(result);
    expect(send).toHaveBeenLastCalledWith({
      feature_id: "overview",
      action: "run_request",
      outcome: "success",
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("private");
  });

  it.each<{ kind: AppErrorKind; status?: number; outcome: string }>([
    { kind: "http", status: 400, outcome: "rejected" },
    { kind: "permission", status: 403, outcome: "rejected" },
    { kind: "auth", status: 401, outcome: "rejected" },
    { kind: "http", status: 409, outcome: "rejected" },
    { kind: "http", status: 429, outcome: "rejected" },
    { kind: "http", status: 408, outcome: "unknown" },
    { kind: "http", status: 503, outcome: "unknown" },
    { kind: "contract", status: 200, outcome: "unknown" },
    { kind: "contract", status: 400, outcome: "unknown" },
    { kind: "network", outcome: "unknown" },
    { kind: "timeout", outcome: "unknown" },
  ])("classifies $kind/$status without claiming an unconfirmed write failed", ({ kind, status, outcome }) => {
    const send = vi.fn();
    dispose = installActionSink(
      () => "overview",
      () => true,
      send,
    );
    captureAction("delete", undefined)?.failure(
      new AppError("private", { kind, status, requestId: "private", details: "private" }),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({ feature_id: "overview", action: "delete", outcome });
  });

  it("drops canceled, logged-out and retired-sink completions without replay", () => {
    const send = vi.fn();
    let current = true;
    dispose = installActionSink(
      () => "overview",
      () => current,
      send,
    );
    const canceled = captureAction("save", undefined);
    canceled?.failure(new AppError("private", { kind: "aborted" }));
    canceled?.success();
    const signedOut = captureAction("save", undefined);
    current = false;
    signedOut?.success();
    current = true;
    const old = captureAction("approve", undefined);
    dispose();
    dispose = installActionSink(
      () => "me.home",
      () => true,
      send,
    );
    old?.success();
    signedOut?.success();
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds intake and keeps observer exceptions out of product results", async () => {
    const send = vi.fn();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    dispose = installActionSink(
      () => "overview",
      () => true,
      send,
    );
    for (let i = 0; i < 25; i++) captureAction("save", undefined)?.success();
    expect(send).toHaveBeenCalledTimes(20);
    now = 60_000;
    captureAction("save", undefined)?.success();
    expect(send).toHaveBeenCalledTimes(21);
    dispose();
    dispose = installActionSink(
      () => "overview",
      () => true,
      () => {
        throw new Error("observer failure");
      },
    );
    await expect(observeAction("save", async () => 42)).resolves.toBe(42);
    const rejection = new Error("private rejection");
    await expect(
      observeAction("save", async () => {
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(
      captureAction(() => {
        throw rejection;
      }, undefined),
    ).toBeUndefined();
  });
});
