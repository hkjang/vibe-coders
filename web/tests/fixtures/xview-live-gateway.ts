import type { Route } from "@playwright/test";
import { test as noteTest } from "./request-note-gateway";

// Synthetic UI data only. Backend authorization/storage contracts are not simulated proof.
export const serverStart = Date.parse("2026-10-08T09:00:00Z");
export const cursor = { ingested_at: "2026-10-08T08:59:59.000000001Z", request_id: "public-cursor" };
export const livePoint = (id: string, createdAt = serverStart - 30_000, latency = 900) => ({
  request_id: id,
  trace_id: `trace-${id}`,
  created_at: new Date(createdAt).toISOString(),
  ingested_at: cursor.ingested_at,
  latency_ms: latency,
  status_code: 200,
  model: "합성 모델",
  provider: "public-provider",
  endpoint: "/v1/chat/completions",
});
type Point = ReturnType<typeof livePoint>;
type Delta = { points: Point[]; cursor: typeof cursor; has_more: boolean; server_time: string };
export interface XViewLiveGateway {
  calls: URL[];
  points: Point[];
  serverTime: string;
  snapshotStatus: number;
  deltaStatus: number;
  respond: (() => Partial<Delta>) | undefined;
}

export const test = noteTest.extend<{ liveGateway: XViewLiveGateway }>({
  liveGateway: async ({ context, gateway }, provide) => {
    // Require the existing note/login fixture first; only two GET reads are overridden.
    void gateway;
    const state: XViewLiveGateway = {
      calls: [],
      points: [livePoint("note-request-one"), livePoint("note-request-two")],
      serverTime: new Date(serverStart).toISOString(),
      snapshotStatus: 200,
      deltaStatus: 200,
      respond: undefined,
    };
    const match = (url: URL) => ["/admin/scatter", "/admin/xview/delta"].includes(url.pathname);
    const handler = async (route: Route) => {
      const url = new URL(route.request().url());
      state.calls.push(url);
      const snapshot = url.pathname === "/admin/scatter";
      const status = snapshot ? state.snapshotStatus : state.deltaStatus;
      const body =
        status !== 200
          ? { error: { message: "synthetic read failure" } }
          : snapshot
            ? {
                points: state.points,
                groups: [],
                truncated: false,
                since: new Date(serverStart - 300_000).toISOString(),
                cursor,
                server_time: state.serverTime,
              }
            : { points: [], cursor, has_more: false, server_time: state.serverTime, ...state.respond?.() };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    };
    await context.route(match, handler);
    await provide(state);
    await context.unroute(match, handler);
  },
});
