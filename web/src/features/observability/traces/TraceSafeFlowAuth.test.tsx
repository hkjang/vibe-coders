import { act, screen, waitFor, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deferred, flow, renderTrace, runtime } from "./trace-safe-flow-test-harness";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useTraceSafeFlowAccess } from "./trace-safe-flow-access";

const table = () => screen.findByRole("table", { name: "기록된 요청 단계와 시간" });

describe("Trace의 확인된 bootstrap 인증 모드", () => {
  it.each([
    ["observability.traces", "observability.traces", true],
    ["observability.requests", "observability.requests", true],
    ["observability.traces", "observability.requests", false],
    ["observability.requests", "observability.traces", false],
  ] as const)("기능 소유자 %s는 호출자가 요구한 %s와 정확히 일치해야 한다", (owner, expected, allowed) => {
    Object.assign(runtime, {
      mode: "authenticated",
      userPresent: true,
      id: "reader-a",
      role: "admin",
      scopes: ["admin:read"],
    });
    const view = renderHook(() => useTraceSafeFlowAccess(expected), {
      wrapper: ({ children }) => (
        <FeatureAccessContext.Provider value={{ featureId: owner, permitted: true, readOnly: true }}>
          {children}
        </FeatureAccessContext.Provider>
      ),
    });
    expect(view.result.current.readable).toBe(allowed);
    expect(view.result.current.routeId).toBe(expected);
    if (allowed) expect(() => view.result.current.assertRead()).not.toThrow();
    else expect(() => view.result.current.assertRead()).toThrow();
  });
  // appUIBootstrapIdentity returns a real user/scopes for these modes. The mode
  // alone is not evidence of permission, and this transport mock enforces none.
  it.each(["legacy", "open"] as const)("%s의 확인된 읽기 사용자는 목록과 단계를 조회한다", async (mode) => {
    const view = renderTrace(undefined, "Asia/Seoul", true, {
      mode,
      id: "legacy-admin",
      role: mode === "legacy" ? "readonly_admin" : "super_admin",
    });
    await table();
    expect(view.calls.filter((call) => call.path === "/admin/requests")).toHaveLength(1);
    expect(view.flowCalls()).toHaveLength(1);
  });

  it.each([
    { mode: "legacy", userPresent: false, scopes: ["admin:read"] },
    { mode: "open", userPresent: false, scopes: ["admin:read"] },
    { mode: "legacy", userPresent: true, scopes: [] },
    { mode: "open", userPresent: true, scopes: [] },
  ] as const)(
    "$mode 모드만으로 없는 사용자/읽기 권한을 추정하지 않는다: $userPresent/$scopes",
    async (input) => {
      const view = renderTrace(undefined, "Asia/Seoul", true, { ...input, scopes: [...input.scopes] });
      expect(await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.")).toBeVisible();
      expect(view.calls).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "새로고침" })).not.toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
    },
  );

  it("동일 사용자라도 인증 모드가 바뀌면 이전 응답과 목록 수명을 재사용하지 않는다", async () => {
    const pending = deferred<unknown>();
    const view = renderTrace(() => pending.promise);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    view.reply(async () => ({ ...flow, spans: [{ ...flow.spans[0], name: "새 인증 모드 기록" }] }));
    act(() => {
      runtime.mode = "legacy";
      view.rerenderRuntime();
    });
    expect(await screen.findByText("새 인증 모드 기록")).toBeVisible();
    await act(async () =>
      pending.resolve({ ...flow, spans: [{ ...flow.spans[0], name: "이전 모드 기록" }] }),
    );
    expect(screen.queryByText("이전 모드 기록")).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(2);
    expect(view.flowCalls()[0]?.signal?.aborted).toBe(true);
    expect(view.calls.filter((call) => call.path === "/admin/requests")).toHaveLength(2);
    expect(view.client.getQueryCache().findAll({ queryKey: ["admin", "app-request-flow"] })).toHaveLength(1);
  });
});
