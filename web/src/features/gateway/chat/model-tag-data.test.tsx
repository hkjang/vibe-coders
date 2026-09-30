import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { mockApi } from "@/test/api";
import { useModelTagData } from "./model-tag-data";
import type { ModelTagAccess } from "./model-tag-access";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const runtime = { owned: true, read: true };
  const assertOwned = () => {
    if (!runtime.owned) throw new AppError("owner", { kind: "aborted" });
  };
  const assertRead = () => {
    assertOwned();
    if (!runtime.read) throw new AppError("read", { kind: "permission" });
  };
  const access: ModelTagAccess = {
    epoch: 1,
    owner: "gateway.chat",
    known: true,
    readAllowed: true,
    assertOwned,
    assertRead,
    write: { allowed: true, reason: undefined, assertCurrent: assertRead },
  };
  let read: () => unknown = () => ({ tags: [] });
  const api = mockApi({ "GET /admin/model-tags": () => read() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = renderHook(() => useModelTagData(access), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return {
    ...view,
    client,
    runtime,
    access,
    api,
    read: (next: () => unknown) => {
      read = next;
    },
  };
}
describe("모델 태그 confirmed 목록과 조회 경계", () => {
  it("최초 pending은 차단하고 정상 빈 목록은 확인된 추가 기준", async () => {
    const current = setup();
    expect(() => current.result.current.assertConfirmed()).toThrow();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    expect(current.result.current.assertConfirmed()).toEqual([]);
  });
  it("invalidated/fetching/error 목록은 이전 정상 데이터가 있어도 차단", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    await act(async () => {
      await current.client.invalidateQueries({ queryKey: ["admin", "model-tags"], refetchType: "none" });
    });
    expect(() => current.result.current.assertConfirmed()).toThrow();
    let reject!: (cause: unknown) => void;
    current.read(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = current.result.current.refresh();
    });
    expect(() => current.result.current.assertConfirmed()).toThrow();
    await act(async () => {
      reject(new AppError("GET failed", { kind: "http" }));
      await pending;
    });
    await waitFor(() => expect(current.result.current.query.isError).toBe(true));
    expect(() => current.result.current.assertConfirmed()).toThrow();
  });
  it("중복 모델 ID의 모호한 목록은 실제 mutation 기준으로 사용 불가", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    const row = {
      model: "same",
      good_for: "",
      avoid_for: "",
      risk_note: "",
      updated_by: "a",
      updated_at: "b",
    };
    act(() => {
      current.client.setQueryData(["admin", "model-tags", 1, "gateway.chat"], { tags: [row, row] });
    });
    expect(() => current.result.current.assertConfirmed()).toThrow();
  });
  for (const change of ["owner", "read", "unmount"]) {
    it(`캡처된 수동 조회는 ${change} 변경 후 새 GET 0`, async () => {
      const current = setup();
      await waitFor(() => expect(current.result.current.confirmed).toBe(true));
      const refresh = current.result.current.refresh;
      const calls = current.api.calls.length;
      if (change === "owner") current.runtime.owned = false;
      if (change === "read") current.runtime.read = false;
      if (change === "unmount") current.unmount();
      await expect(refresh()).rejects.toBeDefined();
      expect(current.api.calls).toHaveLength(calls);
    });
  }
  it("쓰기 성공 시 조회 권한 회수는 캐시를 무효화하되 후속 GET 0", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    current.runtime.read = false;
    const calls = current.api.calls.length;
    act(() => {
      current.result.current.afterCommit();
    });
    expect(current.api.calls).toHaveLength(calls);
    expect(current.client.getQueryState(["admin", "model-tags", 1, "gateway.chat"])?.isInvalidated).toBe(
      true,
    );
  });
  it("쓰기 성공은 기존 모델 카탈로그 태그 캐시도 무효화하되 권한 없이 GET을 추가하지 않음", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    current.client.setQueryData(["admin", "model-tags"], { tags: [] });
    current.runtime.read = false;
    const calls = current.api.calls.length;
    act(() => {
      current.result.current.afterCommit();
    });
    expect(current.client.getQueryState(["admin", "model-tags"])?.isInvalidated).toBe(true);
    expect(current.api.calls).toHaveLength(calls);
  });
  it("허가된 저장 후 자기 GET 1만 수행하고 active 카탈로그와 unrelated query는 자동 조회하지 않음", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    const legacyKey = ["admin", "model-tags"];
    const unrelatedKey = ["admin", "providers"];
    current.client.setQueryData(legacyKey, { tags: [] });
    current.client.setQueryData(unrelatedKey, { providers: [] });
    const catalogRead = vi.fn(async () => ({ tags: [] }));
    const unrelatedRead = vi.fn(async () => ({ providers: [] }));
    const catalog = new QueryObserver(current.client, {
      queryKey: legacyKey,
      queryFn: catalogRead,
      staleTime: Infinity,
    });
    const unrelated = new QueryObserver(current.client, {
      queryKey: unrelatedKey,
      queryFn: unrelatedRead,
      staleTime: Infinity,
    });
    const stopCatalog = catalog.subscribe(() => undefined);
    const stopUnrelated = unrelated.subscribe(() => undefined);
    try {
      const calls = current.api.calls.length;
      act(() => {
        current.result.current.afterCommit();
      });
      await waitFor(() => expect(current.api.calls).toHaveLength(calls + 1));
      await waitFor(() => expect(current.result.current.confirmed).toBe(true));
      expect(current.client.getQueryState(legacyKey)?.isInvalidated).toBe(true);
      expect(current.client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
      expect(catalogRead).not.toHaveBeenCalled();
      expect(unrelatedRead).not.toHaveBeenCalled();
    } finally {
      stopCatalog();
      stopUnrelated();
    }
  });
  it("조회 권한 회수 이후 완료된 GET의 결과는 성공 캐시에 반영하지 않는다", async () => {
    const current = setup();
    await waitFor(() => expect(current.result.current.confirmed).toBe(true));
    let release!: (value: unknown) => void;
    current.read(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = current.result.current.refresh();
    });
    current.runtime.read = false;
    await act(async () => {
      release({ tags: [] });
      await pending;
    });
    await waitFor(() => expect(current.result.current.query.isError).toBe(true));
    expect(current.result.current.confirmed).toBe(false);
  });
});
