import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProbeCsvImport } from "./use-probe-csv-import";
import { readProbeCsvFile, type PreparedProbeCsv, type ProbeCsvReadContext } from "./probe-csv-file";
import { reviewProbePrompts, applyReviewedProbePrompts } from "./redteam-csv";
import type { ProbeCsvReview } from "@/shared/api/domains/redteam-probe-csv-review";
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
vi.mock("./redteam-csv", () => ({ reviewProbePrompts: vi.fn(), applyReviewedProbePrompts: vi.fn() }));
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
const review: ProbeCsvReview = {
  review_supported: true,
  revision: "a".repeat(64),
  file_sha256: "b".repeat(64),
  imported_cases: 1,
  packs_touched: 1,
  skipped: [],
  counts: { created: 1, updated: 0, unchanged: 0 },
  total_items: 1,
  offset: 0,
  limit: 20,
  has_more: false,
  changes: [
    {
      kind: "pack",
      id: "p",
      action: "create",
      before: null,
      after: {
        id: "p",
        name: "public",
        category: "custom",
        severity: "low",
        version: "v1",
        enabled: true,
        requires_approval: false,
      },
    },
  ],
};
const result = {
  review_applied: true as const,
  applied_revision: review.revision,
  imported_cases: 1,
  packs_touched: 1,
  skipped: [] as string[],
};
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
let latest: ReturnType<typeof useProbeCsvImport>;
function Harness({ context = "all" }: { context?: string }) {
  const importer = useProbeCsvImport(runtime.write, "no write", context);
  useLayoutEffect(() => {
    latestRun = () => importer.run(file);
    latest = importer;
  });
  return (
    <>
      <button disabled={!importer.available || importer.open} onClick={() => void importer.run(file)}>
        import
      </button>
      <button
        disabled={!importer.review || importer.pending}
        onClick={() => void importer.apply(importer.review?.revision ?? "")}
      >
        apply
      </button>
      <button onClick={() => importer.close()}>close</button>
      <button disabled={!importer.canReviewAgain} onClick={() => void importer.reviewAgain()}>
        again
      </button>
      <span role="status">{importer.pending ? importer.stage : importer.review ? "reviewed" : "ready"}</span>
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
  vi.clearAllMocks();
  vi.mocked(readProbeCsvFile).mockReset().mockResolvedValue(fixture);
  vi.mocked(reviewProbePrompts)
    .mockReset()
    .mockImplementation(async () => ({ ...review }));
  vi.mocked(applyReviewedProbePrompts).mockReset().mockResolvedValue(result);
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

describe("probe CSV review ownership", () => {
  it("reads before/after without writing and applies only after a separate action", async () => {
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("reviewed"));
    expect(reviewProbePrompts).toHaveBeenCalledExactlyOnceWith(
      fixture.text,
      0,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }),
    );
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
    expect(applyReviewedProbePrompts).toHaveBeenCalledExactlyOnceWith(
      fixture.text,
      review.revision,
      expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }),
    );
    expect(view.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it.each(boundaries)("prevents review/apply when file reading outlives %s", async (boundary) => {
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
    expect(reviewProbePrompts).not.toHaveBeenCalled();
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it.each(boundaries)("discards a late review and stale approval after %s", async (boundary) => {
    const held = deferred<ProbeCsvReview>();
    vi.mocked(reviewProbePrompts).mockReturnValueOnce(held.promise);
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(reviewProbePrompts).toHaveBeenCalledOnce());
    const context = vi.mocked(reviewProbePrompts).mock.calls[0]?.[3];
    const staleApply = latest.apply;
    retire(boundary, view);
    expect(context?.signal?.aborted).toBe(true);
    await act(async () => {
      held.resolve(review);
      await staleApply(review.revision);
    });
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it.each(boundaries)("aborts apply and suppresses late feedback after %s", async (boundary) => {
    const held = deferred<typeof result>();
    vi.mocked(applyReviewedProbePrompts).mockReturnValueOnce(held.promise);
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await userEvent.click(await screen.findByRole("button", { name: "apply" }));
    await waitFor(() => expect(applyReviewedProbePrompts).toHaveBeenCalledOnce());
    const context = vi.mocked(applyReviewedProbePrompts).mock.calls[0]?.[2];
    retire(boundary, view);
    expect(context?.signal?.aborted).toBe(true);
    await act(async () => {
      held.resolve(result);
    });
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
    expect(applyReviewedProbePrompts).toHaveBeenCalledOnce();
  });

  it("does not revive A-to-B-to-A selections or an old selection's apply callback", async () => {
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    const oldApply = latest.apply;
    view.refresh("other");
    view.refresh("all");
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(reviewProbePrompts).toHaveBeenCalledTimes(2));
    await act(async () => {
      await oldApply(review.revision);
    });
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
  });

  it("retires old approval after a same-revision rereview and after closing/reselecting", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    const beforeRereview = latest.apply;
    await userEvent.click(screen.getByRole("button", { name: "again" }));
    await waitFor(() => expect(reviewProbePrompts).toHaveBeenCalledTimes(2));
    await act(async () => {
      await beforeRereview(review.revision);
    });
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    const beforeClose = latest.apply;
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(reviewProbePrompts).toHaveBeenCalledTimes(3));
    await act(async () => {
      await beforeClose(review.revision);
    });
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
  });

  it("serializes same-tick file selections and confirmed apply calls", async () => {
    setup();
    await act(async () => {
      const first = latestRun();
      void latestRun();
      await first;
    });
    expect(readProbeCsvFile).toHaveBeenCalledOnce();
    expect(reviewProbePrompts).toHaveBeenCalledOnce();
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    await act(async () => {
      const first = latest.apply(review.revision);
      void latest.apply(review.revision);
      await first;
    });
    expect(applyReviewedProbePrompts).toHaveBeenCalledOnce();
  });

  it("does not read when the screen retires during optional parser loading", async () => {
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
    expect(reviewProbePrompts).not.toHaveBeenCalled();
  });

  it("shows a local validation error without network calls or cached content", async () => {
    vi.mocked(readProbeCsvFile).mockRejectedValueOnce(
      new AppError("CSV 형식을 확인하세요.", { kind: "contract", code: "invalid_csv" }),
    );
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("CSV 형식을 확인하세요."));
    expect(reviewProbePrompts).not.toHaveBeenCalled();
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    expect(view.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("keeps safe uncertain-write feedback, clears approval and never auto-replays", async () => {
    vi.mocked(applyReviewedProbePrompts).mockRejectedValueOnce(
      new AppError("private CSV contents", { kind: "http", status: 503, requestId: "probe-fixture" }),
    );
    const view = setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    const oldApply = latest.apply;
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("probe-fixture"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("private CSV contents");
    await act(async () => {
      await oldApply(review.revision);
    });
    expect(applyReviewedProbePrompts).toHaveBeenCalledOnce();
    expect(latest.review).toBeUndefined();
    expect(view.invalidate).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "again" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    expect(applyReviewedProbePrompts).toHaveBeenCalledOnce();
  });

  it("requires new review after a paging conflict and binds paging to the prior revision", async () => {
    vi.mocked(reviewProbePrompts).mockResolvedValueOnce({
      ...review,
      total_items: 21,
      counts: { created: 21, updated: 0, unchanged: 0 },
      has_more: true,
    });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    vi.mocked(reviewProbePrompts).mockRejectedValueOnce(
      new AppError("private stale data", { kind: "http", status: 409 }),
    );
    await act(async () => {
      await latest.goTo(20);
    });
    expect(reviewProbePrompts).toHaveBeenLastCalledWith(
      fixture.text,
      20,
      review.revision,
      expect.any(Object),
    );
    expect(latest.review).toBeUndefined();
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("다시 검토");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private");
  });

  it("fails closed for older servers and inconsistent apply receipts", async () => {
    vi.mocked(reviewProbePrompts).mockRejectedValueOnce(
      new AppError("old server", { kind: "http", status: 404 }),
    );
    setup();
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("서버 버전"));
    expect(applyReviewedProbePrompts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "again" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    vi.mocked(applyReviewedProbePrompts).mockResolvedValueOnce({
      ...result,
      applied_revision: "c".repeat(64),
    });
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(latest.review).toBeUndefined());
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it("separates acknowledged apply from failed list refresh", async () => {
    const view = setup();
    view.invalidate.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(latest.review).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledOnce());
    expect(applyReviewedProbePrompts).toHaveBeenCalledOnce();
    expect(notifications.warning).toHaveBeenCalledWith("가져오기는 반영되었습니다. 목록을 다시 불러오세요.", {
      duration: 10_000,
    });
  });
});
