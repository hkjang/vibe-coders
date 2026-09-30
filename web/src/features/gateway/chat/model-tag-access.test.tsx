import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { useModelTagAccess, useModelTagOperation } from "./model-tag-access";

const auth = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: auth.scopes }) };
});
let owner = "gateway.chat";
let permitted = true;
let readOnly = false;
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <FeatureAccessContext value={{ featureId: owner, permitted, readOnly }}>{children}</FeatureAccessContext>
  );
}
beforeEach(() => {
  auth.scopes = ["admin:read", "admin:write"];
  owner = "gateway.chat";
  permitted = true;
  readOnly = false;
  tokenStore.clearAll();
});
function setup() {
  return renderHook(
    () => {
      const access = useModelTagAccess(true, "쓰기 권한 확인");
      return { access, operation: useModelTagOperation(access) };
    },
    { wrapper: Wrapper },
  );
}
function hold<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("모델 태그 실제 작업 경계", () => {
  for (const mode of ["readonly", "write", "read", "owner", "unknown", "epoch", "unmount"]) {
    it(`캡처된 작업은 ${mode} 변경 뒤 요청 0`, async () => {
      const view = setup();
      const captured = view.result.current.operation.run;
      const request = vi.fn(async () => "ok");
      act(() => {
        if (mode === "readonly") readOnly = true;
        if (mode === "write") auth.scopes = ["admin:read"];
        if (mode === "read") auth.scopes = ["admin:write"];
        if (mode === "owner") owner = "gateway.models";
        if (mode === "unknown") permitted = false;
        if (mode === "epoch") tokenStore.clearAll();
      });
      if (mode === "unmount") view.unmount();
      else view.rerender();
      await act(async () => {
        await expect(
          captured(async (assert) => {
            assert();
            return request();
          }),
        ).rejects.toBeDefined();
      });
      expect(request).not.toHaveBeenCalled();
    });
  }
  for (const mode of ["readonly", "write", "read", "owner", "epoch", "unmount"]) {
    it(`비동기 준비 이후 ${mode} 변경은 전송 직전 검사로 요청 0`, async () => {
      const view = setup();
      const gate = hold<undefined>();
      const request = vi.fn(async () => "ok");
      let pending!: Promise<unknown>;
      act(() => {
        pending = view.result.current.operation.run(async (assert) => {
          await gate.promise;
          assert();
          return request();
        });
      });
      act(() => {
        if (mode === "readonly") readOnly = true;
        if (mode === "write") auth.scopes = ["admin:read"];
        if (mode === "read") auth.scopes = ["admin:write"];
        if (mode === "owner") owner = "gateway.models";
        if (mode === "epoch") tokenStore.clearAll();
      });
      if (mode === "unmount") view.unmount();
      else view.rerender();
      await act(async () => {
        gate.resolve(undefined);
        await expect(pending).rejects.toBeDefined();
      });
      expect(request).not.toHaveBeenCalled();
    });
  }
  for (const outcome of ["resolve", "reject"] as const) {
    for (const mode of ["owner", "epoch", "unmount"]) {
      it(`이미 전송된 ${outcome} 결과는 ${mode} 종료 후 알림·갱신 콜백 0`, async () => {
        const view = setup();
        const gate = hold<string>();
        const committed = vi.fn();
        let pending!: Promise<unknown>;
        act(() => {
          pending = view.result.current.operation.run(async (assert) => {
            assert();
            return gate.promise;
          }, committed);
        });
        act(() => {
          if (mode === "owner") owner = "gateway.models";
          if (mode === "epoch") tokenStore.clearAll();
        });
        if (mode === "unmount") view.unmount();
        else view.rerender();
        await act(async () => {
          if (outcome === "resolve") gate.resolve("ok");
          else gate.reject(new Error("late"));
          await expect(pending).rejects.toMatchObject({ kind: "aborted" });
        });
        expect(committed).not.toHaveBeenCalled();
      });
    }
  }
  it("동일 tick 중복 요청을 차단하고 이미 허용된 결과는 readonly 후에도 성공", async () => {
    const view = setup();
    const gate = hold<string>();
    const first = vi.fn(() => gate.promise);
    const duplicate = vi.fn(async () => "duplicate");
    const committed = vi.fn();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = view.result.current.operation.run(async (assert) => {
        assert();
        return first();
      }, committed);
      await expect(view.result.current.operation.run(duplicate)).rejects.toMatchObject({ kind: "aborted" });
    });
    readOnly = true;
    view.rerender();
    await act(async () => {
      gate.resolve("saved");
      expect(await pending).toBe("saved");
    });
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledWith("saved");
  });
  it("외부 access가 유효해도 안쪽 작업 컴포넌트만 unmount하면 캡처된 callback은 요청 0", async () => {
    const outer = renderHook(() => useModelTagAccess(true, "쓰기"), { wrapper: Wrapper });
    const inner = renderHook(() => useModelTagOperation(outer.result.current));
    const captured = inner.result.current.run;
    inner.unmount();
    expect(() => outer.result.current.assertRead()).not.toThrow();
    const request = vi.fn(async () => "ok");
    await expect(captured(request)).rejects.toMatchObject({ kind: "aborted" });
    expect(request).not.toHaveBeenCalled();
  });
});
