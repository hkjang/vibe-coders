import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";

import { useSettingSaveOutcome } from "./setting-save-outcome";
import { useSettingsReloadNotice } from "./use-settings-reload-notice";
import { systemSettingsKeys } from "./use-system-settings";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const key = systemSettingsKeys.effective;
const applied = (upToDate: boolean | undefined) => ({ settings: [], this_pod: { up_to_date: upToDate } });
const persisted = () =>
  new AppError("persisted", {
    kind: "http",
    status: 503,
    code: "setting_reload_pending",
    requestId: "pending-response",
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function setup(write: () => Promise<unknown>, read: () => Promise<ReturnType<typeof applied>>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(key, applied(true));
  const onSuccess = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      useQuery({ queryKey: key, queryFn: read, staleTime: Infinity });
      const outcome = useSettingSaveOutcome();
      const notice = useSettingsReloadNotice();
      const save = useMutationFeedback({
        mutate: () => outcome(write),
        invalidates: [key],
        onSuccess: (result) => {
          onSuccess(result);
          if (result.outcome === "reload_pending") notice.setReloadPending(result);
        },
      });
      return { ...notice, save };
    },
    { wrapper },
  );
  return { ...hook, client, onSuccess };
}

it("자동 조회가 먼저 끝나도 503 응답의 query 세대를 결과에 보존한다", async () => {
  const read = vi.fn(async () => applied(true));
  const { result, client } = setup(async () => {
    throw persisted();
  }, read);
  await act(async () => {
    expect(await result.current.save.mutateAsync()).toMatchObject({
      outcome: "reload_pending",
      requestId: "pending-response",
      observedUpdates: 1,
    });
  });
  expect(read).toHaveBeenCalledOnce();
  expect(client.getQueryState(key)?.dataUpdateCount).toBe(2);
  expect(result.current.reloadPending).toBeUndefined();
});

it("503 응답 전 background true와 응답 뒤 조회 실패를 수렴 근거로 쓰지 않는다", async () => {
  const pending = deferred<unknown>();
  const write = vi.fn(() => pending.promise);
  const read = vi.fn(async () => {
    throw new Error("offline");
  });
  const { result, client } = setup(write, read);
  let completion!: ReturnType<typeof result.current.save.mutateAsync>;
  act(() => {
    completion = result.current.save.mutateAsync();
  });
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  await act(async () => {
    await client.fetchQuery({ queryKey: key, queryFn: async () => applied(true), staleTime: 0 });
  });
  expect(client.getQueryState(key)?.dataUpdateCount).toBe(2);
  await act(async () => {
    pending.reject(persisted());
    expect(await completion).toMatchObject({ outcome: "reload_pending", observedUpdates: 2 });
  });
  expect(read).toHaveBeenCalledOnce();
  expect(client.getQueryState(key)?.dataUpdateCount).toBe(2);
  expect(result.current.reloadPending?.requestId).toBe("pending-response");
});

it.each([false, undefined])("새 조회의 up_to_date=%s이면 반영 대기를 유지한다", async (value) => {
  const { result } = setup(
    async () => {
      throw persisted();
    },
    async () => applied(value),
  );
  await act(async () => {
    await result.current.save.mutateAsync();
  });
  expect(result.current.reloadPending?.requestId).toBe("pending-response");
});

it.each(["write", "refetch"] as const)(
  "%s 대기 중 로그아웃하면 이전 결과를 새 세션에 전달하지 않는다",
  async (stage) => {
    const writeGate = deferred<unknown>();
    const readGate = deferred<ReturnType<typeof applied>>();
    const write = vi.fn(async () => {
      if (stage === "write") return writeGate.promise;
      throw persisted();
    });
    const read = vi.fn(() => readGate.promise);
    const { result, onSuccess } = setup(write, read);
    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.save.mutateAsync().catch((error: unknown) => error);
    });
    await waitFor(() => expect(stage === "write" ? write : read).toHaveBeenCalledOnce());
    act(() => tokenStore.clearAll());
    await act(async () => {
      if (stage === "write") writeGate.reject(persisted());
      else readGate.resolve(applied(true));
      expect(await completion).toMatchObject({ kind: "aborted" });
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.reloadPending).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(stage === "write" ? 0 : 1);
  },
);
