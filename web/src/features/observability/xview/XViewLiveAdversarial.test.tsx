import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useXViewLive } from "@/features/observability/xview/use-xview-live";
import { ApiClient, apiClient } from "@/shared/api/client";

const serverStart = Date.parse("2026-10-08T09:00:00Z");
const clientStart = serverStart + 8 * 60 * 60_000;
const iso = (value: number) => new Date(value).toISOString();
const defaultCursor = { ingested_at: "2026-10-08T08:59:59.000000001Z", request_id: "public-cursor" };
const currentPoint = {
  request_id: "public-current",
  created_at: "2026-10-08T08:59:30Z",
  latency_ms: 1,
  status_code: 200,
};
interface Cursor {
  ingested_at: string;
  request_id: string;
}
interface Delta {
  points: object[];
  cursor: Cursor;
  has_more: boolean;
  server_time?: string;
}
function delta(overrides: Partial<Delta> = {}): Delta {
  return {
    points: [],
    cursor: defaultCursor,
    has_more: false,
    server_time: iso(serverStart + Date.now() - clientStart),
    ...overrides,
  };
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function mountActual({
  cursor = defaultCursor,
  snapshotTime = iso(serverStart),
  points = [currentPoint],
  respond = () => delta(),
}: {
  cursor?: Cursor;
  snapshotTime?: string;
  points?: object[];
  respond?: (poll: number, url: URL) => Delta | Promise<Delta>;
} = {}) {
  const requests: Array<{ url: URL; at: number }> = [];
  let polls = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "http://public-test.invalid");
    requests.push({ url, at: Date.now() - clientStart });
    let response: unknown;
    if (url.pathname === "/admin/scatter") {
      response = {
        points,
        groups: [],
        truncated: false,
        since: iso(serverStart - 300_000),
        cursor,
        server_time: snapshotTime,
      };
    } else if (url.pathname === "/admin/xview/delta") response = await respond(++polls, url);
    else throw new Error(`Unexpected synthetic transport path: ${url.pathname}`);
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  });
  const transport = new ApiClient({
    fetch,
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
    clearTokens: vi.fn(),
    saveTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const filters = { window: "5m" };
  const view = renderHook(() => useXViewLive(filters, true), { wrapper });
  await advance(1);
  expect(view.result.current.initialPending).toBe(false);
  expect(view.result.current.initialError).toBeUndefined();
  return {
    ...view,
    client,
    polls: () => polls,
    deltas: () => requests.filter(({ url }) => url.pathname === "/admin/xview/delta"),
  };
}

describe("independent XView maintenance and cursor boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(clientStart);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("separates normal forward reads, 15s reconciliation, and the higher-priority 300s refresh", async () => {
    const current = await mountActual();
    await advance(300_100);
    const calls = current.deltas();
    const reconciles = calls.filter(({ url }) => url.searchParams.get("reconcile") === "true");
    const refreshes = calls.filter(({ url }) => url.searchParams.get("refresh") === "true");
    expect(calls[0]?.url.searchParams.has("reconcile")).toBe(false);
    expect(calls[0]?.url.searchParams.has("refresh")).toBe(false);
    expect(reconciles.length).toBeGreaterThan(0);
    expect(reconciles[0]?.at).toBeGreaterThanOrEqual(15_000);
    expect(reconciles[0]?.at).toBeLessThan(16_600);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.at).toBeGreaterThanOrEqual(300_000);
    expect(refreshes[0]?.url.searchParams.has("reconcile")).toBe(false);
    expect(calls.every(({ url }) => url.searchParams.get("limit") === "200")).toBe(true);
  });

  it.each([
    { label: "reconcile", holdingPoll: 1, startsAt: 1_500, resolvesAt: 16_000 },
    { label: "refresh", holdingPoll: 199, startsAt: 298_500, resolvesAt: 300_500 },
  ])("does not mix overdue $label metadata reads into a forward catch-up drain", async (scenario) => {
    let release: ((value: Delta) => void) | undefined;
    const held = new Promise<Delta>((resolve) => {
      release = resolve;
    });
    const nextCursor = { ingested_at: "2026-10-08T09:05:00.000000002Z", request_id: "public-next" };
    const current = await mountActual({
      respond: (poll) => {
        if (poll === scenario.holdingPoll) return held;
        return delta({ cursor: poll > scenario.holdingPoll ? nextCursor : defaultCursor });
      },
    });
    await advance(scenario.startsAt);
    expect(current.polls()).toBe(scenario.holdingPoll);
    await advance(scenario.resolvesAt - scenario.startsAt);
    await act(async () => {
      release?.(delta({ cursor: nextCursor, has_more: true }));
    });
    await advance(100);
    const continuation = current.deltas()[scenario.holdingPoll];
    expect(continuation).toBeDefined();
    expect(continuation?.url.searchParams.has("reconcile")).toBe(false);
    expect(continuation?.url.searchParams.has("refresh")).toBe(false);
    expect(continuation?.url.searchParams.get("after_ingested_at")).toBe(nextCursor.ingested_at);
    await advance(1_600);
    const maintenance = current.deltas()[scenario.holdingPoll + 1];
    expect(maintenance?.url.searchParams.get(scenario.label)).toBe("true");
  });

  it.each(["", "not-a-server-time"])(
    "does not use the skewed browser clock to prune when snapshot and delta time are unconfirmed (%s)",
    async (value) => {
      const current = await mountActual({
        snapshotTime: value,
        respond: () => delta({ server_time: value }),
      });
      await advance(16_000);
      expect(current.result.current.initialError).toBeUndefined();
      expect(current.result.current.liveError).toBeUndefined();
      expect(current.result.current.clockConfirmed).toBe(false);
      expect(current.result.current.clockEstimated).toBe(false);
      expect(current.result.current.points.map((point) => point.request_id)).toEqual(["public-current"]);
    },
  );

  it.each(["not-a-server-time", "2026-10-08T08:59:59Z"])(
    "keeps a valid prior clock anchor but discloses unconfirmed subsequent server time (%s)",
    async (value) => {
      const current = await mountActual({
        points: [
          { ...currentPoint, request_id: "public-expiring", created_at: iso(serverStart - 299_000) },
          currentPoint,
        ],
        respond: () => delta({ server_time: value }),
      });
      expect(current.result.current.clockConfirmed).toBe(true);
      const lastSuccess = current.result.current.lastUpdatedAt;
      await advance(16_000);
      expect(current.result.current.clockConfirmed).toBe(false);
      expect(current.result.current.clockEstimated).toBe(true);
      expect(current.result.current.lastUpdatedAt).toBeGreaterThan(lastSuccess);
      expect(current.result.current.points.map((point) => point.request_id)).toEqual(["public-current"]);
    },
  );

  it("does not re-anchor the rolling clock indefinitely when identical server_time is repeated", async () => {
    const current = await mountActual({
      points: [
        { ...currentPoint, request_id: "public-expiring", created_at: iso(serverStart - 299_000) },
        currentPoint,
      ],
      respond: () => delta({ server_time: iso(serverStart) }),
    });
    expect(current.result.current.points).toHaveLength(2);
    await advance(16_000);
    expect(current.result.current.points.map((point) => point.request_id)).toEqual(["public-current"]);
  });

  it("retains nanosecond cursor progress within the same JavaScript millisecond", async () => {
    const nextCursor = { ...defaultCursor, ingested_at: "2026-10-08T08:59:59.000000002Z" };
    const current = await mountActual({
      respond: (poll) => delta({ cursor: nextCursor, has_more: poll === 1 }),
    });
    await advance(1_600);
    expect(current.polls()).toBe(2);
    expect(current.deltas()[1]?.url.searchParams.get("after_ingested_at")).toBe(nextCursor.ingested_at);
  });

  it("accepts opaque tied-timestamp IDs without assuming JavaScript locale or codepoint ordering", async () => {
    const cursor = { ...defaultCursor, request_id: "Ω+%2f?&=#\\\uFEFF" };
    const nextCursor = { ...cursor, request_id: "a" };
    const current = await mountActual({
      cursor,
      respond: (poll) => delta({ cursor: nextCursor, has_more: poll === 1 }),
    });
    await advance(1_600);
    expect(current.polls()).toBe(2);
    expect(current.deltas()[0]?.url.searchParams.get("after_request_id")).toBe(cursor.request_id);
    expect(current.deltas()[1]?.url.searchParams.get("after_request_id")).toBe(nextCursor.request_id);
  });

  it("does not follow a backwards timestamp into an immediate request loop", async () => {
    const initial = { ...defaultCursor, ingested_at: "2026-10-08T08:59:59.000000002Z" };
    const current = await mountActual({
      cursor: initial,
      respond: () => delta({ cursor: defaultCursor, has_more: true }),
    });
    await advance(1_600);
    expect(current.polls()).toBe(1);
    await advance(1_500);
    const next = current.deltas()[1];
    if (next) expect(next.url.searchParams.get("after_ingested_at")).toBe(initial.ingested_at);
  });
});
