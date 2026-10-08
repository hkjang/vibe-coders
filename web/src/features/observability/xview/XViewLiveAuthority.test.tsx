import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, renderHook, screen, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useXViewLive } from "@/features/observability/xview/use-xview-live";
import { XViewPage } from "@/features/observability/xview/XViewPage";
import { useXViewReadOwner } from "@/features/observability/xview/xview-live-access";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

const auth = vi.hoisted(() => ({ principal: "public-owner-a", scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: auth.scopes, user: { id: auth.principal } }),
  };
});

const now = "2026-10-08T09:00:00Z";
const cursor = { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: "public-cursor" };
function point(requestId: string) {
  return { request_id: requestId, created_at: "2026-10-08T08:59:30Z", latency_ms: 10, status_code: 200 };
}
function snapshot(requestId: string) {
  return {
    points: [point(requestId)],
    groups: [],
    truncated: false,
    since: "2026-10-08T08:55:00Z",
    cursor,
    server_time: now,
  };
}
function delta(requestId?: string) {
  return { points: requestId ? [point(requestId)] : [], cursor, has_more: false, server_time: now };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function failure(status: number) {
  return json({ error: { message: "PUBLIC-REJECTED-BODY-CANARY", type: "server_error" } }, status);
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function mountOwned() {
  const response = {
    snapshot: (): Response | Promise<Response> => json(snapshot("public-old-point")),
    delta: (): Response | Promise<Response> => json(delta()),
  };
  const requests: Array<{ path: string; signal: AbortSignal | null | undefined; principal: string }> = [];
  const notifyLogout = vi.fn();
  const clearTokens = vi.fn();
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      requests.push({ path, signal: init?.signal, principal: auth.principal });
      if (path === "/admin/scatter") return response.snapshot();
      if (path === "/admin/xview/delta") return response.delta();
      throw new Error(`Unexpected synthetic transport path: ${path}`);
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: tokenStore.getSessionEpoch,
    clearTokens,
    saveTokens: vi.fn(),
    notifyLogout,
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <FeatureAccessHarness featureId="observability.xview">{children}</FeatureAccessHarness>
    </QueryClientProvider>
  );
  const view = renderHook(
    ({ window }) => {
      const owner = useXViewReadOwner();
      return useXViewLive({ window }, true, owner);
    },
    { wrapper, initialProps: { window: "5m" } },
  );
  await advance(1);
  expect(view.result.current.points.map((entry) => entry.request_id)).toEqual(["public-old-point"]);
  return { ...view, client, response, requests, notifyLogout, clearTokens };
}

describe("independent XView read authority and late transport responses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    auth.principal = "public-owner-a";
    auth.scopes = ["admin:read"];
    tokenStore.clearAll();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });
  afterEach(() => {
    cleanup();
    tokenStore.clearAll();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { path: "delta", status: 401 },
    { path: "delta", status: 403 },
    { path: "snapshot", status: 401 },
    { path: "snapshot", status: 403 },
  ] as const)(
    "retires $path $status without a global logout and only recovers through explicit fresh GET",
    async ({ path, status }) => {
      const current = await mountOwned();
      const epoch = tokenStore.getSessionEpoch();
      current.response[path] = () => failure(status);
      if (path === "snapshot") act(() => current.result.current.refresh());
      await advance(path === "delta" ? 1_600 : 1);
      expect(current.result.current.denied).toBe(true);
      expect(current.result.current.automaticRead).toBe(false);
      expect(current.result.current.points).toEqual([]);
      expect(current.result.current.denialBoundary).toBeDefined();
      const boundary = current.result.current.denialBoundary;
      expect(
        current.client
          .getQueryCache()
          .getAll()
          .every((query) => query.state.data === undefined),
      ).toBe(true);
      expect(
        JSON.stringify(
          current.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state),
        ),
      ).not.toContain("public-old-point");
      expect(current.notifyLogout).not.toHaveBeenCalled();
      expect(current.clearTokens).not.toHaveBeenCalled();
      expect(tokenStore.getSessionEpoch()).toBe(epoch);
      expect(auth.scopes).toEqual(["admin:read"]);
      const afterDenial = current.requests.length;
      await advance(30_000);
      expect(current.requests).toHaveLength(afterDenial);

      current.response.snapshot = () => failure(503);
      act(() => current.result.current.refresh());
      await advance(1);
      expect(current.requests).toHaveLength(afterDenial + 1);
      expect(current.result.current.denied).toBe(true);
      expect(current.result.current.points).toEqual([]);
      expect(
        JSON.stringify(
          current.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state),
        ),
      ).not.toContain("public-old-point");

      const late = deferred();
      current.response.snapshot = () => late.promise;
      act(() => current.result.current.refresh());
      await advance(1);
      expect(current.client.isFetching()).toBe(1);
      await act(async () => {
        await current.client.cancelQueries({}, { revert: true });
      });
      await act(async () => {
        late.resolve(json(snapshot("public-late-cancelled")));
      });
      await advance(1);
      expect(current.result.current.denied).toBe(true);
      expect(current.result.current.points).toEqual([]);
      expect(
        JSON.stringify(
          current.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state),
        ),
      ).not.toContain("public-late-cancelled");

      current.response.snapshot = () => json(snapshot("public-fresh-point"));
      act(() => current.result.current.refresh());
      await advance(1);
      expect(current.result.current.denied).toBe(false);
      expect(current.result.current.automaticRead).toBe(false);
      expect(current.result.current.denialBoundary).toBe(boundary);
      expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-fresh-point"]);
      const afterRecovery = current.requests.length;
      await advance(30_000);
      expect(current.requests).toHaveLength(afterRecovery);
    },
  );

  it("preserves authorized stale points on ordinary 503 instead of treating it as read denial", async () => {
    const current = await mountOwned();
    current.response.delta = () => failure(503);
    await advance(1_600);
    expect(current.result.current.denied).toBe(false);
    expect(current.result.current.automaticRead).toBe(true);
    expect(current.result.current.liveError).toBeTruthy();
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-old-point"]);
    expect(
      current.client
        .getQueryCache()
        .getAll()
        .some((query) => query.state.data !== undefined),
    ).toBe(true);
  });

  it.each(["filter", "principal", "scope", "session"] as const)(
    "discards an abort-ignoring old delta after the %s read lifetime changes",
    async (kind) => {
      const current = await mountOwned();
      const late = deferred();
      current.response.delta = () => late.promise;
      await advance(1_600);
      expect(current.requests.at(-1)?.path).toBe("/admin/xview/delta");
      const oldSignal = current.requests.at(-1)?.signal;
      current.response.snapshot = () => json(snapshot("public-new-owner"));
      current.response.delta = () => json(delta());
      if (kind === "filter") current.rerender({ window: "15m" });
      else if (kind === "principal") {
        auth.principal = "public-owner-b";
        current.rerender({ window: "5m" });
      } else if (kind === "scope") {
        auth.scopes = [];
        current.rerender({ window: "5m" });
      } else act(() => tokenStore.clearAll());
      await advance(1);
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => {
        late.resolve(json(delta("public-old-late-point")));
      });
      await advance(1);
      expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(
        kind === "scope" ? [] : ["public-new-owner"],
      );
      expect(
        JSON.stringify(
          current.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state),
        ),
      ).not.toContain("public-old-late-point");
      expect(current.result.current.denied).toBe(false);
    },
  );

  it("does not attach an old principal's late denial to a recovered A-to-B-to-A owner", async () => {
    const current = await mountOwned();
    const late = deferred();
    current.response.delta = () => late.promise;
    await advance(1_600);
    current.response.snapshot = () => json(snapshot(`public-fresh-${auth.principal}`));
    current.response.delta = () => json(delta());
    auth.principal = "public-owner-b";
    current.rerender({ window: "5m" });
    await advance(1);
    auth.principal = "public-owner-a";
    current.rerender({ window: "5m" });
    await advance(1);
    await act(async () => {
      late.resolve(failure(403));
    });
    await advance(1);
    expect(current.result.current.denied).toBe(false);
    expect(current.result.current.automaticRead).toBe(true);
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual([
      "public-fresh-public-owner-a",
    ]);
  });

  it("uses receipt identity rather than a same-millisecond snapshot timestamp for late delta ownership", async () => {
    const current = await mountOwned();
    const firstStamp = current.client.getQueryCache().getAll()[0]?.state.dataUpdatedAt;
    expect(firstStamp).toBeTypeOf("number");
    if (typeof firstStamp !== "number") throw new Error("Synthetic snapshot query was not initialized");
    const late = deferred();
    current.response.delta = () => late.promise;
    await advance(1_600);
    current.response.snapshot = () => json(snapshot("public-same-ms-fresh"));
    vi.setSystemTime(firstStamp);
    act(() => current.result.current.refresh());
    await advance(0);
    expect(current.client.getQueryCache().getAll()[0]?.state.dataUpdatedAt).toBe(firstStamp);
    await act(async () => {
      late.resolve(json(delta("public-same-ms-old")));
    });
    await advance(1);
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-same-ms-fresh"]);
    expect(current.result.current.denied).toBe(false);
  });

  it("does not reopen a previously selected Page record after terminal denial, 503, and a fresh 200", async () => {
    let snapshotStatus = 200;
    const requests: string[] = [];
    const transport = new ApiClient({
      fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
        const path = new URL(String(input), "http://public-test.invalid").pathname;
        requests.push(path);
        if (path === "/admin/saved-filters") return json({ filters: [] });
        if (path === "/admin/scatter")
          return snapshotStatus === 200 ? json(snapshot("public-selected-record")) : failure(snapshotStatus);
        if (path === "/admin/xview/delta") return failure(403);
        throw new Error(`Unexpected synthetic transport path: ${path}`);
      }),
      getAccessToken: () => "",
      getRefreshToken: () => "",
      getLegacyToken: () => "",
      getSessionEpoch: tokenStore.getSessionEpoch,
      clearTokens: vi.fn(),
      saveTokens: vi.fn(),
      notifyLogout: vi.fn(),
    });
    vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
      transport.request(endpoint, ...args),
    );
    renderScreen(
      <FeatureAccessHarness featureId="observability.xview">
        <XViewPage />
      </FeatureAccessHarness>,
      { path: "/observability/xview", route: "/observability/xview?window=5m" },
    );
    await advance(20);
    fireEvent.click(screen.getByRole("button", { name: "최근 25건 선택" }));
    await advance(20);
    expect(within(screen.getByRole("dialog")).getByText("public-selected-record")).toBeVisible();
    await advance(1_600);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("public-selected-record")).not.toBeInTheDocument();
    const afterDenial = requests.length;
    await advance(30_000);
    expect(requests).toHaveLength(afterDenial);
    snapshotStatus = 503;
    fireEvent.click(screen.getByRole("button", { name: "지금 새로고침" }));
    await advance(20);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("public-selected-record")).not.toBeInTheDocument();
    snapshotStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "지금 새로고침" }));
    await advance(20);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const afterRecovery = requests.length;
    await advance(30_000);
    expect(requests).toHaveLength(afterRecovery);
    fireEvent.click(screen.getByRole("button", { name: "최근 25건 선택" }));
    await advance(20);
    expect(within(screen.getByRole("dialog")).getByText("public-selected-record")).toBeVisible();
  });
});
