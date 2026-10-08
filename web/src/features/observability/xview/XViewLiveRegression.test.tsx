import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useXViewLive, type XViewFilters } from "@/features/observability/xview/use-xview-live";
import { ApiClient, apiClient } from "@/shared/api/client";
import type {
  ScatterPoint,
  ScatterResponse,
  XViewDeltaResponse,
} from "@/shared/api/domains/observability.schemas";

// These are public, synthetic records. No browser credentials or actual network
// are used: only fetch is replaced; ApiClient validates the real endpoint/query
// and parses the actual response schemas before the production hook sees data.
const serverStart = Date.parse("2026-10-08T09:00:00Z");
const clientStart = serverStart + 8 * 60 * 60 * 1_000;
const initialCursor = { ingested_at: "2026-10-08T08:59:59Z", request_id: "public-cursor" };
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

function point(id: string, createdAt = serverStart - 30_000): ScatterPoint {
  return {
    request_id: id,
    trace_id: `trace-${id}`,
    created_at: iso(createdAt),
    ingested_at: initialCursor.ingested_at,
    latency_ms: 900,
    first_chunk_ms: 200,
    status_code: 200,
    provider: "public-provider",
    model: "public-model",
    endpoint: "/v1/chat/completions",
    total_tokens: 120,
    cost_krw: 9,
    stream: true,
    tool_count: 0,
    failover: false,
    complexity: 30,
    risk_score: 5,
    health_score: 90,
    decision_reason: "",
    policy_decision_count: 0,
    policy_decision: "",
    approval_count: 0,
    approval_status: "",
    secret_event_count: 0,
    secret_action: "",
  };
}

function snapshot(points: ScatterPoint[] = [point("public-current")]): ScatterResponse {
  return {
    points,
    groups: [],
    truncated: false,
    since: iso(serverStart - 5 * 60_000),
    cursor: initialCursor,
    server_time: iso(serverStart),
  };
}

function delta(overrides: Partial<XViewDeltaResponse> = {}): XViewDeltaResponse {
  return {
    points: [],
    cursor: initialCursor,
    has_more: false,
    server_time: iso(serverStart + Date.now() - clientStart),
    ...overrides,
  };
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function mountLive({
  initial = snapshot(),
  respond = () => delta(),
  filters = { window: "5m" },
}: {
  initial?: ScatterResponse;
  respond?: (poll: number, url: URL) => XViewDeltaResponse | Response;
  filters?: XViewFilters;
} = {}) {
  const requests: URL[] = [];
  let polls = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "http://public-test.invalid");
    requests.push(url);
    let body: unknown;
    if (url.pathname === "/admin/scatter") body = initial;
    else if (url.pathname === "/admin/xview/delta") body = respond(++polls, url);
    else throw new Error(`Unexpected synthetic transport path: ${url.pathname}`);
    return body instanceof Response
      ? body
      : new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
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
  const view = renderHook(() => useXViewLive(filters, true), { wrapper });
  await advance(1);
  expect(view.result.current.initialPending).toBe(false);
  expect(view.result.current.initialError).toBeUndefined();
  return { ...view, client, requests, polls: () => polls };
}

describe("XView live independent transport regression", () => {
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

  it("expires only points outside the rolling server-time window despite client clock skew", async () => {
    // parseWindow ignores bucket rounding. The initial point is in its 5m
    // window, but has expired after empty server deltas. Allow the legacy
    // poller's 15-second pruning cadence rather than prescribing every tick.
    const current = await mountLive({
      initial: snapshot([point("public-expiring", serverStart - 299_000), point("public-current")]),
    });
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual([
      "public-expiring",
      "public-current",
    ]);
    await advance(16_000);
    expect(current.polls()).toBeGreaterThan(0);
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-current"]);
  });

  it("advances successful synchronization time even when the delta contains no points", async () => {
    const current = await mountLive();
    const previous = current.result.current.lastUpdatedAt;
    await advance(1_600);
    expect(current.polls()).toBe(1);
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-current"]);
    expect(current.result.current.liveError).toBeUndefined();
    expect(current.result.current.lastUpdatedAt).toBeGreaterThan(previous);
  });

  it("discloses truncation when the 6001st distinct live point exceeds a complete snapshot", async () => {
    const initialPoints = Array.from({ length: 6_000 }, (_, index) =>
      point(`public-${index}`, serverStart - 60_000 + index),
    );
    const current = await mountLive({
      initial: snapshot(initialPoints),
      respond: () =>
        delta({
          points: [point("public-new", serverStart)],
          cursor: { ingested_at: iso(serverStart), request_id: "public-new" },
        }),
    });
    expect(current.result.current.truncated).toBe(false);
    await advance(1_600);
    expect(current.result.current.points).toHaveLength(6_000);
    expect(current.result.current.points.some((entry) => entry.request_id === "public-new")).toBe(true);
    expect(current.result.current.points.some((entry) => entry.request_id === "public-0")).toBe(false);
    // XViewPage's cap notice consumes precisely this returned flag.
    expect(current.result.current.truncated).toBe(true);
  });

  it("does not repeatedly drain has_more when the server cursor has not advanced", async () => {
    const current = await mountLive({ respond: () => delta({ has_more: true }) });
    await advance(1_600);
    expect(current.polls()).toBe(1);
  });

  it("keeps an explicit historical from/to range instead of applying rolling-window expiry", async () => {
    const current = await mountLive({
      initial: snapshot([point("public-historical", serverStart - 2 * 60 * 60_000)]),
      filters: { from: "2026-10-08T06:00:00Z", to: "2026-10-08T08:00:00Z" },
      respond: () => delta({ server_time: iso(serverStart + 60 * 60_000) }),
    });
    await advance(1_600);
    expect(current.result.current.points.map((entry) => entry.request_id)).toEqual(["public-historical"]);
  });

  it("does not poll while hidden and resumes one normal poll after visibility returns", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const current = await mountLive();
    await advance(4_500);
    expect(current.polls()).toBe(0);
    expect(current.result.current.paused).toBe(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(1_500);
    expect(current.polls()).toBe(1);
    expect(current.result.current.paused).toBe(false);
  });

  it("retains points and exponentially backs off failures before restoring the normal cadence", async () => {
    const current = await mountLive({
      respond: (poll) =>
        poll <= 2
          ? new Response(
              JSON.stringify({ error: { message: "Synthetic unavailable", type: "server_error" } }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            )
          : delta(),
    });
    await advance(1_599);
    expect(current.polls()).toBe(1);
    expect(current.result.current.liveError).toBeTruthy();
    expect(current.result.current.points).toHaveLength(1);
    await advance(2_899);
    expect(current.polls()).toBe(1);
    await advance(2);
    expect(current.polls()).toBe(2);
    await advance(5_998);
    expect(current.polls()).toBe(2);
    await advance(2);
    expect(current.polls()).toBe(3);
    expect(current.result.current.liveError).toBeUndefined();
    await advance(1_500);
    expect(current.polls()).toBe(4);
  });

  it("drains a genuinely advancing cursor once and forwards that exact cursor to the next GET", async () => {
    const nextCursor = { ingested_at: "2026-10-08T09:00:00.123456789Z", request_id: "public-next" };
    const current = await mountLive({
      respond: (poll) => delta({ cursor: nextCursor, has_more: poll === 1 }),
    });
    await advance(1_600);
    expect(current.polls()).toBe(2);
    const calls = current.requests.filter((url) => url.pathname === "/admin/xview/delta");
    expect(calls[0]?.searchParams.get("after_ingested_at")).toBe(initialCursor.ingested_at);
    expect(calls[1]?.searchParams.get("after_ingested_at")).toBe(nextCursor.ingested_at);
    expect(calls[1]?.searchParams.get("after_request_id")).toBe(nextCursor.request_id);
    expect(calls.every((url) => url.searchParams.get("window") === "5m")).toBe(true);
    expect(calls.every((url) => url.searchParams.get("limit") === "200")).toBe(true);
  });
});
