import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { tokenStore } from "@/shared/auth/token-store";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function setup(mutate: (value: string) => Promise<string>, onSuccess = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const success = vi.spyOn(toast, "success").mockImplementation(() => 1);
  const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => useMutationFeedback({ mutate, onSuccess, invalidates: [["private"]], successMessage: "저장 완료" }),
    { wrapper },
  );
  return { ...hook, client, invalidate, success, error, onSuccess };
}

afterEach(() => tokenStore.clearAll());

describe("mutation authentication boundary", () => {
  it.each(["success", "failure"])(
    "suppresses stale %s callbacks and rejects the caller continuation",
    async (outcome) => {
      const pending = deferred();
      const mutate = vi.fn(() => pending.promise);
      const hook = setup(mutate);
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      const continuation = vi.fn();
      let completion!: Promise<unknown>;
      act(() => {
        completion = hook.result.current
          .mutateAsync("old draft", { onSuccess, onError, onSettled })
          .then(continuation, (error: unknown) => error);
      });
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
      act(() => {
        tokenStore.clearAll();
        tokenStore.saveTokens({ access_token: "new-access", refresh_token: "new-refresh" });
      });
      await act(async () => {
        if (outcome === "success") pending.resolve("old private result");
        else pending.reject(new Error("old private error"));
        await completion;
      });
      expect(continuation).not.toHaveBeenCalled();
      expect(hook.invalidate).not.toHaveBeenCalled();
      expect(hook.success).not.toHaveBeenCalled();
      expect(hook.error).not.toHaveBeenCalled();
      expect(hook.onSuccess).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "failure"])(
    "preserves current-session %s callbacks and original variables",
    async (outcome) => {
      const pending = deferred();
      const hook = setup(() => pending.promise);
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      let completion!: Promise<unknown>;
      act(() => {
        completion = hook.result.current
          .mutateAsync("draft", { onSuccess, onError, onSettled })
          .catch((error: unknown) => error);
      });
      await act(async () => {
        if (outcome === "success") pending.resolve("saved");
        else pending.reject(new Error("failed"));
        await completion;
      });
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled.mock.calls[0]?.[2]).toBe("draft");
      expect(onSuccess).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(onError).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
      expect(hook.success).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(hook.error).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
    },
  );

  it("does not call the server if logout occurs before a scheduled mutation begins", async () => {
    const mutate = vi.fn(async () => "saved");
    const hook = setup(mutate);
    let completion!: Promise<unknown>;
    act(() => {
      completion = hook.result.current.mutateAsync("draft").catch((error: unknown) => error);
      tokenStore.clearAll();
    });
    await act(async () => {
      expect(await completion).toMatchObject({ kind: "aborted" });
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(hook.error).not.toHaveBeenCalled();
  });

  it("isolates concurrent identical variables and does not reset a new session's pending mutation", async () => {
    const older = deferred();
    const newer = deferred();
    const mutate = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const hook = setup(mutate);
    const newSuccess = vi.fn();
    let oldCompletion!: Promise<unknown>;
    let newCompletion!: Promise<unknown>;
    act(() => {
      oldCompletion = hook.result.current.mutateAsync("same").catch((error: unknown) => error);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    act(() => {
      tokenStore.clearAll();
      tokenStore.saveTokens({ access_token: "new", refresh_token: "new-refresh" });
      newCompletion = hook.result.current.mutateAsync("same", { onSuccess: newSuccess });
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(hook.result.current.isPending).toBe(true);
    await act(async () => {
      older.resolve("obsolete");
      await oldCompletion;
    });
    expect(hook.result.current.isPending).toBe(true);
    expect(hook.success).not.toHaveBeenCalled();
    await act(async () => {
      newer.resolve("current");
      await newCompletion;
    });
    await waitFor(() => expect(hook.result.current.data).toBe("current"));
    expect(newSuccess).toHaveBeenCalledTimes(1);
    expect(hook.success).toHaveBeenCalledTimes(1);
  });

  it("rechecks ownership after awaiting invalidation before toast, callbacks and caller continuation", async () => {
    const invalidation = deferred();
    const hook = setup(async () => "saved");
    hook.invalidate.mockImplementation(() => invalidation.promise.then(() => undefined));
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const continuation = vi.fn();
    let completion!: Promise<unknown>;
    act(() => {
      completion = hook.result.current
        .mutateAsync("draft", { onSuccess, onSettled })
        .then(continuation, (error: unknown) => error);
    });
    await waitFor(() => expect(hook.invalidate).toHaveBeenCalledTimes(1));
    act(() => tokenStore.clearAll());
    await act(async () => {
      invalidation.resolve("done");
      await completion;
    });
    expect(hook.success).not.toHaveBeenCalled();
    expect(hook.onSuccess).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(continuation).not.toHaveBeenCalled();
  });

  it("keeps same-session callbacks working across refresh credential rotation", async () => {
    const pending = deferred();
    const hook = setup(() => pending.promise);
    let completion!: Promise<string>;
    act(() => {
      completion = hook.result.current.mutateAsync("draft");
    });
    tokenStore.refreshTokens({ access_token: "rotated", refresh_token: "rotated-refresh" });
    await act(async () => {
      pending.resolve("saved");
      await completion;
    });
    expect(hook.onSuccess).toHaveBeenCalledWith("saved", "draft");
    expect(hook.success).toHaveBeenCalledTimes(1);
  });
});
