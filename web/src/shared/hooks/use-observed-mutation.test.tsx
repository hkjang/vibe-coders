import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { installActionSink } from "@/shared/telemetry/action-channel";
import { useObservedMutation } from "./use-observed-mutation";

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());
function wrapper() {
  const client = new QueryClient();
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
function deferred() {
  let resolve!: (value: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
describe("observed mutation lifecycle", () => {
  it("keeps concurrent submissions independent even when variables have identical identity", async () => {
    const send = vi.fn(),
      pending = [deferred(), deferred()] as const,
      body = { secret: "private" };
    dispose = installActionSink(
      () => "gateway.providers",
      () => true,
      send,
    );
    let index = 0;
    const accepted = vi.fn(),
      settled = vi.fn();
    const hook = renderHook(
      () =>
        useObservedMutation({
          observation: "save",
          mutationFn: async (value: typeof body) => {
            expect(value).toBe(body);
            const flight = pending[index++];
            if (!flight) throw new Error("Unexpected third write");
            return flight.promise;
          },
          onSuccess: accepted,
          onSettled: settled,
        }),
      { wrapper: wrapper() },
    );
    let first!: Promise<unknown>, second!: Promise<unknown>;
    act(() => {
      first = hook.result.current.mutateAsync(body);
      second = hook.result.current.mutateAsync(body).catch((error: unknown) => error);
    });
    await waitFor(() => expect(index).toBe(2));
    await act(async () => {
      pending[1].reject(new AppError("private", { kind: "http", status: 409 }));
      await second;
      pending[0].resolve("private result");
      await first;
    });
    expect(send.mock.calls.map(([event]) => event.outcome)).toEqual(["rejected", "success"]);
    expect(accepted.mock.calls[0]?.slice(0, 2)).toEqual(["private result", body]);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(hook.result.current.variables).toBe(body);
    expect(JSON.stringify(send.mock.calls)).not.toContain("private");
  });

  it("waits for semantic validation and discards cancellation; never auto-retries writes", async () => {
    const send = vi.fn();
    dispose = installActionSink(
      () => "overview",
      () => true,
      send,
    );
    const mutate = vi.fn(async (kind: "contract" | "aborted") => {
      await Promise.resolve({ status: 200 });
      throw new AppError("invalid or stale acknowledgement", { kind });
    });
    const hook = renderHook(
      () => useObservedMutation({ observation: "delete", mutationFn: mutate, retry: 3 }),
      { wrapper: wrapper() },
    );
    await act(async () => {
      await expect(hook.result.current.mutateAsync("contract")).rejects.toMatchObject({ kind: "contract" });
      await expect(hook.result.current.mutateAsync("aborted")).rejects.toMatchObject({ kind: "aborted" });
    });
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "overview",
      action: "delete",
      outcome: "unknown",
    });
  });

  it("does not recategorize an acknowledged write when a presentation callback throws", async () => {
    const send = vi.fn();
    dispose = installActionSink(
      () => "overview",
      () => true,
      send,
    );
    const hook = renderHook(
      () =>
        useObservedMutation({
          observation: "save",
          mutationFn: async () => "ack",
          onSuccess: () => {
            throw new Error("presentation failure");
          },
        }),
      { wrapper: wrapper() },
    );
    await act(async () => {
      await expect(hook.result.current.mutateAsync()).rejects.toThrow("presentation failure");
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "overview",
      action: "save",
      outcome: "success",
    });
  });
});

it.each(["success", "rejected", "unknown"] as const)(
  "drops %s from an unmounted mutation owner",
  async (outcome) => {
    const send = vi.fn(),
      pending = deferred();
    dispose = installActionSink(
      () => "agents.apps",
      () => true,
      send,
    );
    const hook = renderHook(
      () => useObservedMutation({ observation: "test", mutationFn: () => pending.promise }),
      { wrapper: wrapper() },
    );
    let result!: Promise<unknown>;
    act(() => {
      result = hook.result.current.mutateAsync().catch((error: unknown) => error);
    });
    hook.unmount();
    const next = renderHook(
      () => useObservedMutation({ observation: "test", mutationFn: async () => "new owner" }),
      { wrapper: wrapper() },
    );
    await act(async () => {
      if (outcome === "success") pending.resolve("old response");
      else
        pending.reject(
          new AppError("old response", { kind: "http", status: outcome === "rejected" ? 409 : 503 }),
        );
      await result;
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await next.result.current.mutateAsync();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "agents.apps",
      action: "test",
      outcome: "success",
    });
  },
);

it("drops failure after the selection lifetime ends without unmounting", async () => {
  const send = vi.fn(),
    pending = deferred();
  let current = true;
  dispose = installActionSink(
    () => "agents.apps",
    () => true,
    send,
  );
  const hook = renderHook(
    () =>
      useObservedMutation({
        observation: "test",
        ownsObservation: () => current,
        mutationFn: () => pending.promise,
      }),
    { wrapper: wrapper() },
  );
  let result!: Promise<unknown>;
  act(() => {
    result = hook.result.current.mutateAsync().catch((error: unknown) => error);
  });
  current = false;
  await act(async () => {
    pending.reject(new AppError("old selection", { kind: "http", status: 409 }));
    await result;
  });
  expect(send).not.toHaveBeenCalled();
});
