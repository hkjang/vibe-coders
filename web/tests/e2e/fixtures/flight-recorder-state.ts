import { expect, test as base, type BrowserContext, type Download, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { FlightRecorderEvent } from "../../../src/shared/api/domains/observability.schemas";
import { sessionAccount, sessionA, sessionB, sessionList } from "./session-list-state";

export { sessionAccount, sessionA, sessionB, sessionList };
export function recorder(sessionId = sessionA.session_id, patch: Partial<FlightRecorderEvent> = {}) {
  const event = {
    request_id: "public-flight-request",
    trace_id: "public-flight-trace",
    kind: "chat",
    endpoint: "/v1/chat/completions",
    model: "공개 비행기록 모델",
    provider: "공개 공급자",
    status_code: 200,
    is_error: false,
    latency_ms: 820,
    total_tokens: 1200,
    cost_krw: 90,
    tool_count: 1,
    created_at: "2026-10-01T00:00:00Z",
    last_message: "public-preview-not-a-csv-column",
    secret_events: 0,
    policy_blocks: 0,
    code_risk: "",
    ...patch,
  };
  return {
    session_id: sessionId,
    events: [event],
    summary: { verdict: "정상", headline: "공개 합성 비행기록의 서버 요약", findings: ["공개 요약 항목"] },
    rollup: {
      requests: 1,
      started_at: event.created_at,
      ended_at: event.created_at,
      models: [event.model],
      providers: [event.provider],
      trace_ids: [event.trace_id],
      kinds: { chat: 1 },
      total_tokens: event.total_tokens,
      total_cost: event.cost_krw,
      errors: event.is_error ? 1 : 0,
      tool_calls: event.tool_count,
      risk: { secret_requests: 0, policy_block_requests: 0, high_risk_code_requests: 0 },
    },
    // Intentionally inaccurate legacy note: new UI must not amplify this claim.
    note: "최근 상한 500개 요청이며 원문은 포함되지 않습니다.",
  };
}

type Reply = { body: unknown; status?: number; requestId?: string };
type Hold = { promise: Promise<void>; release: () => void };
type Call = { url: URL; headers: Record<string, string> };
async function installGateway(context: BrowserContext, page: Page, origin: string) {
  let user = structuredClone(sessionAccount);
  let mode: "session" | "legacy_token" | "open" = "session";
  let prefixes = ["corp_"];
  let loginSerial = 0;
  let logoutCount = 0;
  const tokens = new Set<string>();
  const listCalls: Call[] = [];
  const detailCalls: Call[] = [];
  const finished: number[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  const downloads: Download[] = [];
  const holds = new Map<number, Hold>();
  const replies = new Map<number, Reply>();
  const targets = new Map<string, Reply>();
  const periods = new Map<number, Reply>();
  page.on("download", (download) => downloads.push(download));
  await page.addInitScript(() => {
    const evidence = { created: [] as string[], revoked: [] as string[], nativeBlobs: [] as boolean[] };
    Object.defineProperty(window, "__flightBlobEvidence", { value: evidence });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      evidence.created.push(url);
      evidence.nativeBlobs.push(object instanceof Blob);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      evidence.revoked.push(url);
      revoke(url);
    };
  });
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.36",
      ui_version: "synthetic-flight-recorder",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/observability/sessions",
        legacy_fallback: true,
        feedback_enabled: false,
        telemetry_enabled: false,
      },
      authentication: {
        enabled: mode === "session",
        authenticated,
        mode,
        keycloak_enabled: false,
        allow_local_login: true,
        sso_login_url: "/auth/keycloak/login",
        credential_prefixes: prefixes,
      },
      ...(authenticated ? { user } : {}),
      roles: authenticated ? user.roles : [],
      permissions: authenticated ? user.scopes : [],
      capabilities: { raw_prompt_view: false },
      allowed_features: authenticated ? ["observability.sessions"] : [],
      migration_registry: [
        {
          feature_id: "observability.sessions",
          title: "세션 비행기록",
          app_path: "/app/observability/sessions",
          legacy_path: "/admin#/sessions",
          status: "preview_read_only",
          risk_level: "low",
          required_permission: "admin:read",
          read_only: true,
          enabled_roles: ["super_admin", "admin", "readonly_admin"],
          rollout_percent: 100,
          fallback_enabled: true,
          minimum_api_version: "v0.84.0",
          // Availability is not a fixture-side current-scope oracle.
          available: authenticated,
        },
      ],
      system_status: { status: "healthy" },
      legacy_route_map: { "/app/observability/sessions": "/admin#/sessions" },
    };
  }
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    if (url.origin !== origin) {
      unexpected.push(`external ${request.method()} ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    const json = (body: unknown, status = 200, requestId = "public-flight-response") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: sessionAccount.email, password: "public-password" });
      const access = `public-flight-access-${++loginSerial}`;
      tokens.add(`Bearer ${access}`);
      return json({
        access_token: access,
        refresh_token: "public-flight-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    const authenticated = mode === "open" || tokens.has(request.headers().authorization ?? "");
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        logoutCount += 1;
        tokens.clear();
        return json({ status: "ok" });
      }
      if (call === "GET /auth/me") return json({ user });
      if (request.method() !== "GET") writes.push(call);
      if (call === "GET /admin/sessions") {
        listCalls.push({ url, headers: request.headers() });
        const days = Number(url.searchParams.get("days"));
        const reply = structuredClone(periods.get(days) ?? { body: sessionList(days) });
        return json(reply.body, reply.status, reply.requestId);
      }
      if (request.method() === "GET" && /^\/admin\/sessions\/[^/]+\/flight-recorder$/u.test(url.pathname)) {
        detailCalls.push({ url, headers: request.headers() });
        const sequence = detailCalls.length;
        const target = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        // Capture old reply BEFORE waiting. No target, membership, current-role,
        // response-ID equality or freshness enforcement substitutes for the UI.
        const reply = structuredClone(
          replies.get(sequence) ?? targets.get(target) ?? { body: recorder(target) },
        );
        await holds.get(sequence)?.promise;
        await json(reply.body, reply.status, reply.requestId);
        finished.push(sequence);
        return;
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
    unexpected.push(call);
    return route.abort("blockedbyclient");
  });
  return {
    listCalls,
    detailCalls,
    finished,
    unexpected,
    writes,
    downloads,
    logouts: () => logoutCount,
    reply: (sequence: number, reply: Reply) => replies.set(sequence, structuredClone(reply)),
    target: (id: string, reply: Reply) => targets.set(id, structuredClone(reply)),
    period: (days: number, reply: Reply) => periods.set(days, structuredClone(reply)),
    readable: (allowed: boolean) => {
      user = { ...user, scopes: allowed ? [...sessionAccount.scopes] : [] };
    },
    owner: (id: string) => {
      user = { ...user, id };
    },
    team: (team_id: string) => {
      user = { ...user, team_id };
    },
    prefixes: (next: string[]) => {
      prefixes = [...next];
    },
    authMode: (next: "legacy_token" | "open") => {
      mode = next;
      const role = next === "legacy_token" ? "readonly_admin" : "super_admin";
      user = { ...user, id: "legacy-admin", email: "", role, roles: [role] };
      if (next === "legacy_token") tokens.add("Bearer public-flight-legacy");
    },
    hold: (sequence: number) => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(sequence, { promise, release });
    },
    release: (sequence: number) => holds.get(sequence)?.release(),
    releaseAll: () => {
      for (const hold of holds.values()) hold.release();
    },
  };
}
export type FlightRecorderGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: FlightRecorderGateway }>({
  gateway: async ({ context, page, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected local synthetic base URL");
    const gateway = await installGateway(context, page, new URL(baseURL).origin);
    try {
      await run(gateway);
    } finally {
      gateway.releaseAll();
      await context.unrouteAll({ behavior: "wait" });
      expect(gateway.unexpected).toEqual([]);
      expect(gateway.writes).toEqual([]);
    }
  },
});
