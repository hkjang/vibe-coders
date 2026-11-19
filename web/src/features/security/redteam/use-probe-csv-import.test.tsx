import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProbeCsvImport } from "./use-probe-csv-import";
import { readProbeCsvFile, type PreparedProbeCsv, type ProbeCsvReadContext } from "./probe-csv-file";
import { importProbePrompts } from "./redteam-csv";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { AppError } from "@/shared/api/error";

const runtime = vi.hoisted(() => ({
  id: "account_a",
  team: "team_a",
  read: true,
  write: true,
  security: true,
  permitted: true,
  readOnly: false,
}));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("./probe-csv-file", () => ({ readProbeCsvFile: vi.fn() }));
vi.mock("./redteam-csv", () => ({ importProbePrompts: vi.fn() }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: [
          runtime.read ? "admin:read" : "",
          runtime.write ? "admin:write" : "",
          runtime.security ? "security:read" : "",
        ].filter(Boolean),
        user: { id: runtime.id, team_id: runtime.team },
      }),
  };
});
const fixture: PreparedProbeCsv = {
  text: "case_key,input_template\nk,t\n",
  filename: "prompts.csv",
  format: "legacy",
  rows: 1,
  validRows: 1,
  skippedRows: 0,
};
const result = { imported_cases: 1, packs_touched: 1, skipped: [] };
const file = new File([fixture.text], fixture.filename, { type: "text/csv" });
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
let latestRun: () => Promise<void>;
function Harness({ context = "all" }: { context?: string }) {
  const importer = useProbeCsvImport(runtime.write, "no write", context);
  useLayoutEffect(() => {
    latestRun = () => importer.run(file);
  });
  return (
    <>
      <button disabled={!importer.available || importer.pending} onClick={() => void importer.run(file)}>
        import
      </button>
      <span role="status">{importer.pending ? importer.stage : "ready"}</span>
      {importer.error ? (
        <p role="alert">
          {importer.error.message} {importer.error.requestId}
        </p>
      ) : null}
    </>
  );
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessContext
          value={{
            featureId: "security.redteam",
            permitted: runtime.permitted,
            readOnly: runtime.readOnly,
            status: "preview",
          }}
        >
          {children}
        </FeatureAccessContext>
      </QueryClientProvider>
    );
  }
  const view = render(<Harness />, { wrapper: Wrapper });
  return {
    ...view,
    client,
    invalidate,
    refresh: (context = "all") => view.rerender(<Harness context={context} />),
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "account_a",
    team: "team_a",
    read: true,
    write: true,
    security: true,
    permitted: true,
    readOnly: false,
  });
  tokenStore.clearAll();
  vi.mocked(readProbeCsvFile).mockResolvedValue(fixture);
  vi.mocked(importProbePrompts).mockResolvedValue(result);
});
afterEach(() => {
  tokenStore.clearAll();
});
const boundaries = [
  "account",
  "team",
  "read",
  "write",
  "security",
  "feature",
  "readOnly",
  "filters",
  "logout",
  "unmount",
] as const;
function retire(boundary: (typeof boundaries)[number], view: ReturnType<typeof setup>) {
  if (boundary === "account") runtime.id = "account_b";
  if (boundary === "team") runtime.team = "team_b";
  if (boundary === "read") runtime.read = false;
  if (boundary === "write") runtime.write = false;
  if (boundary === "security") runtime.security = false;
  if (boundary === "feature") runtime.permitted = false;
  if (boundary === "readOnly") runtime.readOnly = true;
  if (boundary === "unmount") view.unmount();
  else if (boundary === "logout") act(() => tokenStore.clearAll());
  else view.refresh(boundary === "filters" ? "other" : "all");
}

describe("probe CSV import ownership", () => {
  it.each(boundaries)("prevents upload when file reading outlives %s", async (boundary) => {
    const held = deferred<PreparedProbeCsv>();
    let context: ProbeCsvReadContext | undefined;
    vi.mocked(readProbeCsvFile).mockImplementation(async (_file, value) => {
      context = value;
      return held.promise;
    });
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    expect(screen.getByRole("status")).toHaveTextContent("reading");
    const retiredRun = latestRun;
    retire(boundary, view);
    expect(context?.signal.aborted).toBe(true);
    await act(async () => {
      held.resolve(fixture);
      await retiredRun();
    });
    expect(readProbeCsvFile).toHaveBeenCalledOnce();
    expect(importProbePrompts).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it.each(boundaries)("aborts the upload and suppresses late feedback after %s", async (boundary) => {
    const held = deferred<typeof result>();
    vi.mocked(importProbePrompts).mockReturnValue(held.promise);
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(importProbePrompts).toHaveBeenCalledOnce());
    const context = vi.mocked(importProbePrompts).mock.calls[0]?.[1];
    expect(screen.getByRole("status")).toHaveTextContent("uploading");
    retire(boundary, view);
    expect(context?.signal?.aborted).toBe(true);
    await act(async () => {
      held.resolve(result);
    });
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
    expect(importProbePrompts).toHaveBeenCalledOnce();
  });

  it("does not revive an A-to-B-to-A file selection and accepts a fresh manual selection", async () => {
    const held = deferred<PreparedProbeCsv>();
    vi.mocked(readProbeCsvFile).mockReturnValueOnce(held.promise);
    const view = setup();
    const oldRun = latestRun;
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    view.refresh("other");
    view.refresh("all");
    await act(async () => {
      held.resolve(fixture);
      await oldRun();
    });
    expect(importProbePrompts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
    expect(readProbeCsvFile).toHaveBeenCalledTimes(2);
    expect(importProbePrompts).toHaveBeenCalledExactlyOnceWith(
      fixture.text,
      expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }),
    );
    expect(view.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("serializes same-tick selections before reading or posting twice", async () => {
    const held = deferred<PreparedProbeCsv>();
    vi.mocked(readProbeCsvFile).mockReturnValueOnce(held.promise);
    setup();
    let first: Promise<void> | undefined;
    act(() => {
      first = latestRun();
      void latestRun();
    });
    await waitFor(() => expect(readProbeCsvFile).toHaveBeenCalledOnce());
    await act(async () => {
      held.resolve(fixture);
      await first;
    });
    expect(importProbePrompts).toHaveBeenCalledOnce();
    expect(notifications.success).toHaveBeenCalledOnce();
  });

  it("does not read or submit if the screen retires while loading the optional parser", async () => {
    const view = setup();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = latestRun();
    });
    view.unmount();
    await act(async () => {
      await pending;
    });
    expect(readProbeCsvFile).not.toHaveBeenCalled();
    expect(importProbePrompts).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it("shows a safe file validation failure without submitting or caching content", async () => {
    vi.mocked(readProbeCsvFile).mockRejectedValueOnce(
      new AppError("CSV 형식을 확인하세요.", { kind: "contract", code: "invalid_csv" }),
    );
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("CSV 형식을 확인하세요."));
    expect(importProbePrompts).not.toHaveBeenCalled();
    expect(view.client.getMutationCache().getAll()).toHaveLength(0);
    expect(notifications.error).toHaveBeenCalledWith(
      "CSV 형식을 확인하세요.",
      expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
    );
  });

  it("keeps a request id for an uncertain write and does not replay it", async () => {
    vi.mocked(importProbePrompts).mockRejectedValueOnce(
      new AppError("private CSV contents", { kind: "http", status: 503, requestId: "probe-fixture" }),
    );
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("probe-fixture"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("private CSV contents");
    expect(importProbePrompts).toHaveBeenCalledOnce();
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it("reports a successful write separately from a failed refresh and never repeats the write", async () => {
    vi.mocked(importProbePrompts).mockResolvedValueOnce({ ...result, skipped: ["private row contents"] });
    const view = setup();
    view.invalidate.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
    expect(importProbePrompts).toHaveBeenCalledOnce();
    expect(notifications.warning).toHaveBeenCalledWith("가져오기는 반영되었습니다. 목록을 다시 불러오세요.");
    expect(JSON.stringify(notifications.warning.mock.calls)).not.toContain("private row contents");
    expect(notifications.error).not.toHaveBeenCalled();
  });
});
