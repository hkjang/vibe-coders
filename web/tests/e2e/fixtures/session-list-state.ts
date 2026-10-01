import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { SessionSummary } from "../../../src/shared/api/domains/observability.schemas";

export const sessionAccount = {
  id: "public-session-reader",
  email: "session-reader@example.invalid",
  name: "공개 세션 조회자",
  role: "readonly_admin",
  roles: ["readonly_admin"],
  team_id: "public-session-team",
  scopes: ["admin:read"],
};
export const sessionA: SessionSummary = {
  session_id: "public-session-alpha",
  requests: 12,
  first_seen: "2026-10-01T00:00:00Z",
  last_seen: "2026-10-01T01:00:00Z",
  models: 2,
  api_keys: 1,
  errors: 1,
  total_tokens: 4200,
  cost_krw: 380,
  last_message: "공개 설계 검토 미리보기",
};
export const sessionB: SessionSummary = {
  ...sessionA,
  session_id: "public-session-beta",
  requests: 3,
  errors: 0,
  total_tokens: 1200,
  cost_krw: 90,
  last_message: "공개 회귀 검사 미리보기",
};
export const sessionC: SessionSummary = {
  ...sessionA,
  session_id: "public-session-month",
  requests: 47,
  errors: 4,
  total_tokens: 9300,
  cost_krw: 820,
  last_message: "한 달 공개 운영 검토 미리보기",
};
export function sessionList(days: number, sessions: SessionSummary[] = [sessionA, sessionB]) {
  return { days, sessions, note: "공개 합성 세션 목록" };
}
function recorder(sessionId: string) {
  return {
    session_id: sessionId,
    events: [
      {
        request_id: "public-session-request",
        trace_id: "public-session-trace",
        kind: "chat",
        endpoint: "/v1/chat/completions",
        model: "공개 모델",
        provider: "public-provider",
        status_code: 200,
        is_error: false,
        latency_ms: 820,
        total_tokens: 1200,
        cost_krw: 90,
        tool_count: 1,
        created_at: "2026-10-01T00:00:00Z",
        last_message: "공개 미리보기",
        secret_events: 0,
        policy_blocks: 0,
        code_risk: "",
      },
    ],
    summary: { verdict: "정상", headline: "공개 합성 세션의 제한된 최근 요청", findings: [] },
    rollup: {
      requests: 1,
      started_at: "2026-10-01T00:00:00Z",
      ended_at: "2026-10-01T00:00:00Z",
      models: ["공개 모델"],
      providers: ["public-provider"],
      trace_ids: ["public-session-trace"],
      kinds: { chat: 1 },
      total_tokens: 1200,
      total_cost: 90,
      errors: 0,
      tool_calls: 1,
      risk: { secret_requests: 0, policy_block_requests: 0, high_risk_code_requests: 0 },
    },
    note: "공개 합성 비행기록",
  };
}

type Reply = { body: unknown; status?: number; requestId?: string };
type Hold = { promise: Promise<void>; release: () => void };
type Call = { url: URL; headers: Record<string, string> };
async function installGateway(context: BrowserContext, origin: string) {
  let user = structuredClone(sessionAccount);
  let authenticationMode: "session" | "legacy_token" | "open" = "session";
  let prefixes = ["corp_"];
  const authenticatedTokens = new Set<string>();
  const listCalls: Call[] = [];
  const detailCalls: Call[] = [];
  const finished: number[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  const holds = new Map<number, Hold>();
  const replies = new Map<number, Reply>();
  const periodReplies = new Map<number, Reply>();
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.35",
      ui_version: "synthetic-session-list",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/observability/sessions",
        legacy_fallback: true,
        feedback_enabled: false,
        telemetry_enabled: false,
      },
      authentication: {
        enabled: authenticationMode === "session",
        authenticated,
        mode: authenticationMode,
        keycloak_enabled: false,
        allow_local_login: true,
        sso_login_url: "/auth/keycloak/login",
        credential_prefixes: prefixes,
      },
      ...(authenticated ? { user } : {}),
      roles: authenticated ? user.roles : [],
      permissions: authenticated ? user.scopes : [],
      capabilities: { raw_prompt_view: false },
      // Deliberately not a permission oracle: real FeatureRoute/local admission
      // must inspect current permissions even while server availability is true.
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
    const json = (body: unknown, status = 200, requestId = "public-session-list") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: sessionAccount.email, password: "public-password" });
      authenticatedTokens.add("Bearer public-session-access");
      return json({
        access_token: "public-session-access",
        refresh_token: "public-session-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    const authenticated =
      authenticationMode === "open" || authenticatedTokens.has(request.headers().authorization ?? "");
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        authenticatedTokens.clear();
        return json({ status: "ok" });
      }
      if (call === "GET /auth/me") return json({ user });
      if (request.method() !== "GET") writes.push(call);
      if (call === "GET /admin/sessions") {
        listCalls.push({ url, headers: request.headers() });
        const sequence = listCalls.length;
        const days = Number(url.searchParams.get("days"));
        // Capture before waiting: a superseded request really carries old data.
        const reply = structuredClone(
          replies.get(sequence) ??
            periodReplies.get(days) ?? {
              body: sessionList(days, days === 30 ? [sessionC] : [sessionA, sessionB]),
            },
        );
        await holds.get(sequence)?.promise;
        await json(reply.body, reply.status, reply.requestId);
        finished.push(sequence);
        return;
      }
      if (request.method() === "GET" && /^\/admin\/sessions\/[^/]+\/flight-recorder$/u.test(url.pathname)) {
        detailCalls.push({ url, headers: request.headers() });
        // No row-membership, freshness, scope or period enforcement here. This
        // transport must not manufacture a successful UI guard-negative proof.
        const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return json(recorder(sessionId));
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
    reply: (sequence: number, next: Reply) => replies.set(sequence, structuredClone(next)),
    periodReply: (days: number, next: Reply) => periodReplies.set(days, structuredClone(next)),
    resetPeriod: (days: number) => periodReplies.delete(days),
    readable: (allowed: boolean) => {
      user = { ...user, scopes: allowed ? [...sessionAccount.scopes] : [] };
    },
    team: (team_id: string) => {
      user = { ...user, team_id };
    },
    owner: (id: string) => {
      user = { ...user, id };
    },
    prefixes: (next: string[]) => {
      prefixes = [...next];
    },
    authMode: (mode: "legacy_token" | "open") => {
      authenticationMode = mode;
      const role = mode === "legacy_token" ? "readonly_admin" : "super_admin";
      user = { ...user, id: "legacy-admin", email: "", role, roles: [role] };
      if (mode === "legacy_token") authenticatedTokens.add("Bearer public-session-legacy");
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
      for (const item of holds.values()) item.release();
    },
  };
}
export type SessionListGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: SessionListGateway }>({
  gateway: async ({ context, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected local synthetic base URL");
    const gateway = await installGateway(context, new URL(baseURL).origin);
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
