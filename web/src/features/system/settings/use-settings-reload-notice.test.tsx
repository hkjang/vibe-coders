import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { useSettingsReloadNotice } from "./use-settings-reload-notice";
import { systemSettingsKeys } from "./use-system-settings";
import { tokenStore } from "@/shared/auth/token-store";

const key = systemSettingsKeys.effective;
const applied = (upToDate: boolean | undefined) => ({ settings: [], this_pod: { up_to_date: upToDate } });

function setup(upToDate: boolean | undefined = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, applied(upToDate));
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useSettingsReloadNotice(), { wrapper }) };
}

describe("설정 반영 대기 조회 세대", () => {
  it("기존 적용 완료 캐시로 새 실패를 지우지 않고 같은 시각의 새 성공 조회로 해제한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { client, result } = setup();
    act(() => result.current.setReloadPending({ requestId: "pending-one", observedUpdates: 1 }));
    expect(result.current.reloadPending?.requestId).toBe("pending-one");
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => applied(true) });
    });
    expect(result.current.reloadPending).toBeUndefined();
  });

  it("조회 실패와 적용 여부 누락으로 대기 상태를 해제하지 않는다", async () => {
    const { client, result } = setup();
    act(() => result.current.setReloadPending({ requestId: "pending-one", observedUpdates: 1 }));
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: key,
          queryFn: async () => {
            throw new Error("offline");
          },
        })
        .catch(() => undefined);
    });
    expect(result.current.reloadPending?.requestId).toBe("pending-one");
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => applied(undefined) });
    });
    expect(result.current.reloadPending?.requestId).toBe("pending-one");
  });

  it("완료된 과거 요청 식별자를 이후 서버 반영 지연에 다시 붙이지 않는다", async () => {
    const { client, result } = setup(false);
    act(() => result.current.setReloadPending({ requestId: "completed-request", observedUpdates: 1 }));
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => applied(true) });
    });
    expect(result.current.reloadPending).toBeUndefined();
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => applied(false) });
    });
    expect(result.current.reloadPending).toEqual({});
  });

  it("새로 연 탭은 요청 이력 없이 서버 반영 대기를 표시한다", () => {
    const { result } = setup(false);
    expect(result.current.reloadPending).toEqual({});
  });

  it("정상 복구 결과는 조회 메타데이터가 없는 경우에도 로컬 실패를 지운다", () => {
    const { result } = setup(undefined);
    act(() => result.current.setReloadPending({ requestId: "old", observedUpdates: 1 }));
    expect(result.current.reloadPending).toBeDefined();
    act(() => result.current.setReloadPending(undefined));
    expect(result.current.reloadPending).toBeUndefined();
  });

  it("응답 뒤의 빠른 조회가 callback 전에 끝나도 응답 세대와 비교해 해제한다", async () => {
    const { client, result } = setup();
    const observedUpdates = client.getQueryState(key)?.dataUpdateCount ?? 0;
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => applied(true) });
      result.current.setReloadPending({ requestId: "fast", observedUpdates });
    });
    expect(result.current.reloadPending).toBeUndefined();
  });

  it("같은 인스턴스여도 인증 세대가 바뀌면 이전 요청 안내를 폐기한다", () => {
    const { result } = setup();
    act(() => result.current.setReloadPending({ requestId: "old-session", observedUpdates: 1 }));
    expect(result.current.reloadPending?.requestId).toBe("old-session");
    act(() => tokenStore.clearAll());
    expect(result.current.reloadPending).toBeUndefined();
  });
});
