import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCostGuard } from "./use-cost-guard";
import { costGuardQueryKeys } from "@/shared/api/domains/cost-guard";
import { tokenStore } from "@/shared/auth/token-store";
import { mockApi } from "@/test/api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ backendVersion: "v0.86.15" }) };
});
beforeEach(() => tokenStore.clearAll());
const config = { enabled: true, threshold_krw: 500 };
const values = { enabled: false, thresholdKrw: 123.5 };

function setup() {
  const api = mockApi({ "GET /admin/cost": () => config, "POST /admin/cost": () => config });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const epoch = tokenStore.getSessionEpoch();
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(({ canWrite }) => useCostGuard(canWrite, epoch), {
    wrapper: Wrapper,
    initialProps: { canWrite: true },
  });
  return { ...hook, api, client };
}

describe("비용 보호 실제 제출 경계", () => {
  it("고정 baseline은 캐시와 분리되고 이전 close가 새 인스턴스를 닫지 않는다", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.confirmed).toEqual(config));
    act(() => result.current.open(document.createElement("button")));
    const first = result.current.target;
    if (!first) throw new Error("missing first cost draft");
    expect(first.baseline).not.toBe(client.getQueryData(costGuardQueryKeys.governance));
    act(() => {
      result.current.close(first.instance);
      result.current.open(document.createElement("button"));
    });
    const second = result.current.target;
    expect(second?.instance).not.toBe(first.instance);
    act(() => result.current.close(first.instance));
    expect(result.current.target).toBe(second);
  });
  it("무효화된 실제 query state로 직접 open이나 submit할 수 없다", async () => {
    const { result, client, api } = setup();
    await waitFor(() => expect(result.current.confirmed).toEqual(config));
    act(() => result.current.open(document.createElement("button")));
    const target = result.current.target;
    if (!target) throw new Error("missing cost draft");
    await act(async () => {
      void client.invalidateQueries({
        queryKey: costGuardQueryKeys.governance,
        exact: true,
        refetchType: "none",
      });
      // Deliberately invoke the handler captured before the observer rerenders.
      await expect(result.current.submit(target, values)).rejects.toMatchObject({ kind: "contract" });
    });
    expect(api.bodies("POST /admin/cost")).toEqual([]);
    act(() => {
      result.current.close(target.instance);
      result.current.open(document.createElement("button"));
    });
    expect(result.current.target).toBeUndefined();
  });
  it("변경 권한이 회수되면 직접 호출도 저장하지 않는다", async () => {
    const { result, rerender, api } = setup();
    await waitFor(() => expect(result.current.confirmed).toEqual(config));
    act(() => result.current.open(document.createElement("button")));
    const target = result.current.target;
    if (!target) throw new Error("missing cost draft");
    rerender({ canWrite: false });
    await expect(result.current.submit(target, values)).rejects.toMatchObject({ kind: "permission" });
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("로그아웃과 같은 tick에서 호출해도 이전 세션으로 저장하지 않는다", async () => {
    const { result, api } = setup();
    await waitFor(() => expect(result.current.confirmed).toEqual(config));
    act(() => result.current.open(document.createElement("button")));
    const target = result.current.target;
    if (!target) throw new Error("missing cost draft");
    await act(async () => {
      tokenStore.clearAll();
      await expect(result.current.submit(target, values)).rejects.toMatchObject({ kind: "permission" });
    });
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
});
