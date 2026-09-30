import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./chat-stream-test-support";
import { useChatAccess } from "./use-chat-access";
import { useChatComputation } from "./use-chat-computation";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

beforeEach(() => tokenStore.clearAll());
function setup(kind: "preview" | "code") {
  const policy = { write: true, preview: true, readOnly: false, owner: "gateway.chat", missing: false };
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <FeatureAccessContext.Provider
        value={
          policy.missing ? undefined : { featureId: policy.owner, permitted: true, readOnly: policy.readOnly }
        }
      >
        {children}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderHook(
    () => {
      const access = useChatAccess(policy.write, policy.preview, "admin:write 권한이 필요합니다.");
      return useChatComputation<string>(access, kind);
    },
    { wrapper: Wrapper },
  );
  return { ...view, policy };
}
describe("단일 채팅 순수 계산의 기존 권한과 수신 소유권", () => {
  for (const kind of ["preview", "code"] as const) {
    it(`${kind}는 readonly라도 기존 권한으로 수동 계산1을 허용한다`, async () => {
      const view = setup(kind),
        execute = vi.fn(async () => "public result");
      view.policy.readOnly = true;
      view.rerender();
      await act(async () => view.result.current.run(execute));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(view.result.current.result).toBe("public result");
    });
    it.each(["scope", "owner", "missing", "session", "unmount"])(
      `${kind} captured callback %s는 계산0`,
      async (boundary) => {
        const view = setup(kind),
          run = view.result.current.run,
          execute = vi.fn(async () => "not sent");
        if (boundary === "scope") {
          if (kind === "preview") view.policy.preview = false;
          else view.policy.write = false;
        }
        if (boundary === "owner") view.policy.owner = "gateway.models";
        if (boundary === "missing") view.policy.missing = true;
        if (boundary === "session") act(() => tokenStore.clearAll());
        if (boundary === "unmount") view.unmount();
        else view.rerender();
        await act(async () => run(execute));
        expect(execute).not.toHaveBeenCalled();
      },
    );
    it.each([false, true])(`${kind} 세션 뒤 늦은 실패=%s는 결과/오류를 남기지 않는다`, async (failure) => {
      const view = setup(kind),
        gate = deferred<string>();
      let completion!: Promise<void>;
      act(() => {
        completion = view.result.current.run(() => gate.promise);
      });
      act(() => tokenStore.clearAll());
      await act(async () => {
        if (failure) gate.reject(new Error("old computation"));
        else gate.resolve("old result");
        await completion;
      });
      expect(view.result.current.result).toBeUndefined();
      expect(view.result.current.error).toBeUndefined();
    });
  }
  it("라우팅 미리보기는 admin:write 없이 routing:read만 유지하며 코드 검증 권한을 대신하지 않는다", async () => {
    const view = setup("preview"),
      execute = vi.fn(async () => "public preview");
    view.policy.write = false;
    view.policy.readOnly = true;
    view.rerender();
    await act(async () => view.result.current.run(execute));
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "새 호출로 지운 코드 검증의 늦은 실패=%s와 finally는 새 계산을 건드리지 않는다",
    async (failure) => {
      const view = setup("code"),
        old = deferred<string>(),
        next = deferred<string>();
      let oldCompletion!: Promise<void>, nextCompletion!: Promise<void>;
      act(() => {
        oldCompletion = view.result.current.run(() => old.promise);
      });
      act(() => view.result.current.clear());
      act(() => {
        nextCompletion = view.result.current.run(() => next.promise);
      });
      await act(async () => {
        if (failure) old.reject(new Error("old code"));
        else old.resolve("old code");
        await oldCompletion;
      });
      expect(view.result.current.pending).toBe(true);
      expect(view.result.current.result).toBeUndefined();
      expect(view.result.current.error).toBeUndefined();
      await act(async () => {
        next.resolve("new code");
        await nextCompletion;
      });
      expect(view.result.current.result).toBe("new code");
    },
  );
});
