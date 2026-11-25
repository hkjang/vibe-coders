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
