import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useXViewLive } from "./use-xview-live";
import { ApiClient, apiClient } from "@/shared/api/client";

const cursor = { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: "public-cursor" };
const point = (id: string) => ({ request_id: id, created_at: "2026-10-08T08:59:30Z", latency_ms: 10 });
const snapshot = (id: string) => ({ points: [point(id)], cursor, server_time: "2026-10-08T09:00:00Z" });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["active", "none"] as const)(
  "invalidating the live Query with refetchType %s retires a pending old delta before React cleanup",
  async (refetchType) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const lateDelta = deferred(),
      newSnapshot = deferred();
    let snapshots = 0;
    const transport = new ApiClient({
      fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
        const path = new URL(String(input), "http://public-test.invalid").pathname;
        if (path === "/admin/scatter")
          return ++snapshots === 1 ? json(snapshot("public-before")) : newSnapshot.promise;
        if (path === "/admin/xview/delta") return lateDelta.promise;
        throw new Error(`Unexpected synthetic path: ${path}`);
      }),
      getAccessToken: () => "",
      getRefreshToken: () => "",
      getLegacyToken: () => "",
      getSessionEpoch: () => 0,
      saveTokens: vi.fn(),
      clearTokens: vi.fn(),
      notifyLogout: vi.fn(),
    });
    vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
      transport.request(endpoint, ...args),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useXViewLive({ window: "5m" }, true), { wrapper });
    await advance(1);
    expect(view.result.current.points.map((entry) => entry.request_id)).toEqual(["public-before"]);
    await advance(1_600);
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["observability", "xview"], refetchType });
      lateDelta.resolve(
        json({
          points: [point("public-old-delta")],
          cursor,
          has_more: false,
          server_time: "2026-10-08T09:00:01Z",
        }),
      );
    });
    await advance(1);
    expect(view.result.current.points.map((entry) => entry.request_id)).toEqual(["public-before"]);
    expect(view.result.current.active).toBe(false);
    expect(view.result.current.snapshotInvalidated).toBe(true);
    expect(view.result.current.snapshotFetching).toBe(refetchType === "active");
    expect(snapshots).toBe(refetchType === "active" ? 2 : 1);
    if (refetchType === "none") {
      act(() => view.result.current.refresh());
      await advance(1);
    }
    await act(async () => {
      newSnapshot.resolve(json(snapshot("public-after")));
    });
    await advance(1);
    expect(view.result.current.points.map((entry) => entry.request_id)).toEqual(["public-after"]);
    expect(view.result.current.snapshotInvalidated).toBe(false);
    expect(view.result.current.snapshotFetching).toBe(false);
    expect(view.result.current.active).toBe(true);
  },
);
