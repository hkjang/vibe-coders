import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareAccess } from "./use-compare-access";
import { useCompareOperation } from "./use-compare-operation";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { FeatureAccess } from "@/shared/feature-access/policy";

const runtime = vi.hoisted(() => ({ write: true, read: true, raw: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: [...(runtime.write ? ["admin:write"] : []), ...(runtime.read ? ["admin:read"] : [])],
        rawPromptView: runtime.raw,
      }),
  };
});
let context: FeatureAccess | undefined;
beforeEach(() => {
  runtime.write = true;
  runtime.read = true;
  runtime.raw = true;
  context = { featureId: "gateway.chat", permitted: true, readOnly: false };
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());
function Wrapper({ children }: PropsWithChildren) {
  return <FeatureAccessContext.Provider value={context}>{children}</FeatureAccessContext.Provider>;
}
function setup() {
  return renderHook(
    () => {
      const access = useCompareAccess(runtime.write, "admin:write 권한이 필요합니다.");
      return { access, ...useCompareOperation(access) };
    },
    { wrapper: Wrapper },
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("비교 실제 실행 callback의 전송·세대 경계", () => {
  it("외부 access가 살아 있어도 내부 작업만 unmount된 옛 callback은 API0이다", async () => {
    const parent = renderHook(() => useCompareAccess(true, "admin:write 권한이 필요합니다."), {
      wrapper: Wrapper,
    });
    const child = renderHook(() => useCompareOperation(parent.result.current));
    const captured = child.result.current.execute;
    child.unmount();
    expect(parent.result.current.isCurrent()).toBe(true);
    const request = vi.fn(async () => "public-result");
    await act(async () => captured("run", request, vi.fn()));
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["run", "judge"] as const)(
    "캡처된 %s callback은 최신 readonly에서0, 수동 복구 뒤1",
    async (kind) => {
      const view = setup();
      const captured = view.result.current.execute;
      const request = vi.fn(async () => "public-result");
      const commit = vi.fn();
      context = { featureId: "gateway.chat", permitted: true, readOnly: true };
      view.rerender();
      await act(async () => captured(kind, request, commit));
      expect(request).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      context = { featureId: "gateway.chat", permitted: true, readOnly: false };
      view.rerender();
      expect(request).not.toHaveBeenCalled();
      await act(async () => captured(kind, request, commit));
      expect(request).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith("public-result");
    },
  );

  it.each(["run", "judge", "predict"] as const)(
    "캡처된 %s는 현재 admin:write가 없으면 전송하지 않는다",
    async (kind) => {
      const view = setup();
      const captured = view.result.current.execute;
      runtime.write = false;
      view.rerender();
      const request = vi.fn(async () => "public-result");
      await act(async () => captured(kind, request, vi.fn()));
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "wrong", "denied", "epoch", "unmounted"])(
    "%s 소유권을 잃은 실제 callback은4종 모두 API0",
    async (boundary) => {
      const view = setup();
      const captured = view.result.current.execute;
      if (boundary === "missing") context = undefined;
      if (boundary === "wrong") context = { featureId: "gateway.models", permitted: true, readOnly: false };
      if (boundary === "denied") context = { featureId: "gateway.chat", permitted: false, readOnly: false };
      if (boundary === "epoch") act(() => tokenStore.clearAll());
      if (boundary === "unmounted") view.unmount();
      else view.rerender();
      const request = vi.fn(async () => "public-result");
      for (const kind of ["run", "judge", "predict", "code"] as const)
        await act(async () => captured(kind, request, vi.fn()));
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["predict", "code"] as const)("readonly는 순수 %s의 기존 권한을 없애지 않는다", async (kind) => {
    context = { featureId: "gateway.chat", permitted: true, readOnly: true };
    const view = setup();
    const request = vi.fn(async () => "public-result");
    await act(async () => view.result.current.execute(kind, request, vi.fn()));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "raw"] as const)("코드 결과 조회는 %s 권한이 없으면 API0", async (permission) => {
    const view = setup();
    const captured = view.result.current.execute;
    runtime[permission] = false;
    view.rerender();
    const request = vi.fn(async () => "public-result");
    await act(async () => captured("code", request, vi.fn()));
    expect(request).not.toHaveBeenCalled();
  });

  it("같은 tick 중복과 다른 작업도 이미 잡힌 flight를 통과하지 못한다", async () => {
    const view = setup();
    const hold = deferred<string>();
    const request = vi.fn(() => hold.promise);
    const commit = vi.fn();
    let first!: Promise<void>;
    act(() => {
      first = view.result.current.execute("run", request, commit);
      void view.result.current.execute("run", request, commit);
      void view.result.current.execute("judge", request, commit);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending).toBe("run");
    await act(async () => {
      hold.resolve("public-result");
      await first;
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending).toBe("");
  });

  it.each(["readonly", "scope"])(
    "admission 뒤 %s 변경은 이미 받은 응답을 거짓 실패로 만들지 않는다",
    async (boundary) => {
      const view = setup();
      const hold = deferred<string>();
      const commit = vi.fn();
      let admitted!: Promise<void>;
      act(() => {
        admitted = view.result.current.execute("run", () => hold.promise, commit);
      });
      if (boundary === "readonly") context = { featureId: "gateway.chat", permitted: true, readOnly: true };
      else runtime.write = false;
      view.rerender();
      await act(async () => {
        hold.resolve("public-result");
        await admitted;
      });
      expect(commit).toHaveBeenCalledWith("public-result");
      expect(view.result.current.error).toBeUndefined();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "이전 계정의 %s/finally가 새 계정의 진행중 작업을 해제하지 않는다",
    async (settlement) => {
      const view = setup();
      const old = deferred<string>();
      const next = deferred<string>();
      const oldCommit = vi.fn();
      const newCommit = vi.fn();
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = view.result.current.execute("run", () => old.promise, oldCommit);
      });
      act(() => tokenStore.clearAll());
      act(() => {
        second = view.result.current.execute("judge", () => next.promise, newCommit);
      });
      await act(async () => {
        if (settlement === "resolve") old.resolve("old-public");
        else old.reject(new Error("old-public-error"));
        await first;
      });
      expect(oldCommit).not.toHaveBeenCalled();
      expect(view.result.current.pending).toBe("judge");
      expect(view.result.current.error).toBeUndefined();
      const duplicate = vi.fn(async () => "duplicate");
      await act(async () => view.result.current.execute("run", duplicate, vi.fn()));
      expect(duplicate).not.toHaveBeenCalled();
      await act(async () => {
        next.resolve("new-public");
        await second;
      });
      expect(newCommit).toHaveBeenCalledWith("new-public");
    },
  );

  it("요청 ID 실패를 표시하고 자동 재시도 없이 명시적 수동 요청만 재실행한다", async () => {
    const { AppError } = await import("@/shared/api/error");
    const view = setup();
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new AppError("public-error", { kind: "http", status: 503, requestId: "req_public_compare" }),
      )
      .mockResolvedValue("public-result");
    const commit = vi.fn();
    await act(async () => view.result.current.execute("run", request, commit));
    expect(view.result.current.error?.requestId).toBe("req_public_compare");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => view.result.current.execute("run", request, commit));
    expect(request).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith("public-result");
  });
});
