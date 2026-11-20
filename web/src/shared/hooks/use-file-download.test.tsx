import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { createPath, Router, type Navigator } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFileDownload, type FileDownloadContext } from "@/shared/hooks/use-file-download";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { AppError } from "@/shared/api/error";
import { SearchLocationContext } from "@/shared/hooks/search-location";

let location = { pathname: "/app/governance/reports", search: "", key: "initial" };
const readLocation = () => location;
const navigator: Navigator = {
  createHref: (to) => (typeof to === "string" ? to : createPath(to)),
  go: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
};

const runtime = vi.hoisted(() => ({ id: "account_a", read: true, permitted: true, readOnly: false }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: runtime.read ? ["admin:read"] : [], user: { id: runtime.id } }),
  };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
let latestRun!: () => Promise<void>;
function Harness({
  task,
  context = "30d",
  enabled = true,
}: {
  task: (value: FileDownloadContext) => Promise<void>;
  context?: string;
  enabled?: boolean;
}) {
  const download = useFileDownload("governance.reports", context, enabled);
  const run = () => download.run(task, { successMessage: "downloaded", errorMessage: "export failed" });
  useLayoutEffect(() => {
    latestRun = run;
  });
  return (
    <>
      <button disabled={!download.available} onClick={() => void run()}>
        download
      </button>
      <span role="status">{download.pending ? "pending" : "ready"}</span>
      {download.error ? <p role="alert">{download.error.message}</p> : null}
    </>
  );
}
function setup(task: (value: FileDownloadContext) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Router location={location} navigator={navigator}>
        <QueryClientProvider client={client}>
          <FeatureAccessContext
            value={{
              featureId: "governance.reports",
              permitted: runtime.permitted,
              readOnly: runtime.readOnly,
              status: "preview",
            }}
          >
            <SearchLocationContext value={readLocation}>{children}</SearchLocationContext>
          </FeatureAccessContext>
        </QueryClientProvider>
      </Router>
    );
  }
  const view = render(<Harness task={task} />, { wrapper: Wrapper });
  return {
    ...view,
    refresh: (context = "30d", enabled = true) =>
      view.rerender(<Harness task={task} context={context} enabled={enabled} />),
  };
}
beforeEach(() => {
  Object.assign(runtime, { id: "account_a", read: true, permitted: true, readOnly: false });
  location = { pathname: "/app/governance/reports", search: "", key: "initial" };
  tokenStore.clearAll();
});
afterEach(() => {
  tokenStore.clearAll();
});

describe("file export ownership", () => {
  it.each(["account", "read", "feature", "filters", "enabled", "logout", "unmount"])(
    "aborts and suppresses late saving and feedback after %s",
    async (boundary) => {
      const held = deferred();
      const saved = vi.fn();
      let signal: AbortSignal | undefined;
      const task = vi.fn(async (context: FileDownloadContext) => {
        signal = context.signal;
        await held.promise;
        context.assertCurrent();
        saved();
      });
      const view = setup(task);
      await userEvent.click(screen.getByRole("button", { name: "download" }));
      expect(task).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("pending");
      const oldRun = latestRun;
      if (boundary === "account") runtime.id = "account_b";
      if (boundary === "read") runtime.read = false;
      if (boundary === "feature") runtime.permitted = false;
      if (boundary === "unmount") view.unmount();
      else if (boundary === "logout") act(() => tokenStore.clearAll());
      else view.refresh(boundary === "filters" ? "7d" : "30d", boundary !== "enabled");
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        held.resolve();
      });
      await act(async () => {
        await oldRun();
      });
      expect(task).toHaveBeenCalledOnce();
      expect(saved).not.toHaveBeenCalled();
      expect(notifications.success).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
    },
  );

  it("does not revive A-to-B-to-A callbacks and permits a fresh export", async () => {
    const held = deferred();
    const saved = vi.fn();
    const task = vi.fn(async (context: FileDownloadContext) => {
      await held.promise;
      context.assertCurrent();
      saved();
    });
    const view = setup(task);
    const originalRun = latestRun;
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    view.refresh("7d");
    view.refresh("30d");
    await act(async () => {
      held.resolve();
      await originalRun();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(task).toHaveBeenCalledTimes(2);
    expect(notifications.success).toHaveBeenCalledOnce();
  });

  it.each(["query", "page", "history"])(
    "discards a file after event-time %s navigation before React commits and permits a fresh export",
    async (boundary) => {
      const held = deferred();
      const saved = vi.fn();
      const task = vi.fn(async (context: FileDownloadContext) => {
        await held.promise;
        context.assertCurrent();
        saved();
      });
      const view = setup(task);
      await userEvent.click(screen.getByRole("button", { name: "download" }));
      const oldRun = latestRun;
      // Router state changes synchronously; React may still render the old filters.
      location = {
        pathname: boundary === "page" ? "/app/governance/assets" : location.pathname,
        search: boundary === "query" ? "?window=7d" : location.search,
        key: "next-navigation",
      };
      await act(async () => {
        held.resolve();
      });
      await act(async () => {
        await oldRun();
      });
      expect(task).toHaveBeenCalledOnce();
      expect(saved).not.toHaveBeenCalled();
      expect(notifications.success).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
      view.refresh(boundary === "query" ? "7d" : "30d");
      expect(screen.getByRole("status")).toHaveTextContent("ready");
      await userEvent.click(screen.getByRole("button", { name: "download" }));
      await waitFor(() => expect(saved).toHaveBeenCalledOnce());
      expect(task).toHaveBeenCalledTimes(2);
      expect(notifications.success).toHaveBeenCalledOnce();
    },
  );

  it("serializes synchronous clicks and keeps read-only exports available", async () => {
    runtime.readOnly = true;
    const held = deferred();
    const task = vi.fn(async (context: FileDownloadContext) => {
      await held.promise;
      context.assertCurrent();
    });
    setup(task);
    expect(screen.getByRole("button", { name: "download" })).toBeEnabled();
    let first!: Promise<void>;
    act(() => {
      first = latestRun();
      void latestRun();
    });
    expect(task).toHaveBeenCalledOnce();
    await act(async () => {
      held.resolve();
      await first;
    });
    expect(screen.getByRole("status")).toHaveTextContent("ready");
    expect(notifications.success).toHaveBeenCalledExactlyOnceWith("downloaded");
  });

  it("keeps current failures with request id until dismissed and allows a new attempt", async () => {
    const task = vi
      .fn<(context: FileDownloadContext) => Promise<void>>()
      .mockRejectedValueOnce(
        new AppError("unavailable", { kind: "http", status: 500, requestId: "export-fixture" }),
      )
      .mockResolvedValueOnce(undefined);
    setup(task);
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(expect.any(String), {
        description: "요청 ID: export-fixture",
        duration: Number.POSITIVE_INFINITY,
      }),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
    expect(task).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
