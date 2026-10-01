import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { TraceSafeFlow } from "../../../src/shared/api/domains/trace-safe-flow.schema";

export const requestAccount = {
  id: "public-request-reader",
  email: "flow-reader@example.invalid",
  name: "공개 요청 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-request-team",
  scopes: ["admin:read"],
};
export const flowRequestA = {
  request_id: "[값 비공개]",
  request_ref: `req_${"a".repeat(22)}.${"a".repeat(21)}`,
  request_filterable: false,
  trace_id: "",
  trace_filterable: false,
  session_id: "public-flow-session",
  api_key_id: "public-key-label",
  ip: "192.0.2.10",
  method: "POST",
  model: "공개 요청 모델",
  provider_ref: `prv_${"p".repeat(43)}`,
  provider_display: "공개 공급자",
  endpoint: "/v1/chat/completions",
  stream: true,
  status_code: 200,
  latency_ms: 450,
  first_chunk_ms: 40,
  prompt_tokens: 10,
  completion_tokens: 20,
  total_tokens: 30,
  cached_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost: 5,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-10-01T00:00:00.123456789Z",
};
export const flowRequestB = {
  ...flowRequestA,
  request_ref: `req_${"b".repeat(22)}.${"b".repeat(21)}`,
  model: "두 번째 공개 모델",
  created_at: "2026-10-01T00:00:01.123456789Z",
};
export const spanRef = (letter: string) => `span_${letter.repeat(43)}`;
export function safeFlow(row = flowRequestA): TraceSafeFlow {
  return {
    flow_version: 1,
    request_ref: row.request_ref,
    created_at: row.created_at,
    generated_at: "2026-10-01T00:00:03.000000000Z",
    spans: [
      {
        span_ref: spanRef("r"),
        parent_ref: null,
        kind: "request",
        name: "게이트웨이 요청",
        status: "ok",
        recorded_at: row.created_at,
        offset_ms: 0,
        duration_ms: 450,
      },
      {
        span_ref: spanRef("t"),
        parent_ref: spanRef("r"),
        kind: "mcp_tool",
        name: row.request_ref === flowRequestA.request_ref ? "공개 검색 도구" : "두 번째 조회 도구",
        status: "unknown",
        recorded_at: "2026-10-01T00:00:00.118456789Z",
        offset_ms: row.request_ref === flowRequestA.request_ref ? -5 : -1005,
        duration_ms: null,
      },
      {
        span_ref: spanRef("s"),
        parent_ref: spanRef("r"),
        kind: "text2sql",
        name: "권한 검사",
        status: "error",
        recorded_at: "2026-10-01T00:00:01.123456789Z",
        offset_ms: row.request_ref === flowRequestA.request_ref ? 1000 : 0,
        duration_ms: 0,
      },
    ],
    coverage: {
      tools: { limit: 100, truncated: false, omitted: 0 },
      text2sql: { limit: 100, truncated: false, omitted: 0 },
    },
  };
}

type Reply = { body: unknown; status?: number; requestId?: string };
type Hold = { promise: Promise<void>; release: () => void };
async function installGateway(context: BrowserContext, origin: string) {
  let user = structuredClone(requestAccount);
  let authenticationMode: "session" | "legacy_token" | "open" = "session";
  let prefixes = ["corp_"];
  let rows = [structuredClone(flowRequestA), structuredClone(flowRequestB)];
  let listReads = 0;
  let contractVersion: 1 | 2 = 2;
  const listCalls: URL[] = [];
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const finished: number[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  const sessions = new Set<string>();
  const holds = new Map<string, Hold>();
  const replies = new Map<number, Reply>();
  const listReplies = new Map<number, Reply>();
  function hold(kind: string, sequence: number) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(`${kind}:${sequence}`, { promise, release });
  }
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.34",
      ui_version: "synthetic-safe-flow",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/observability/requests",
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
      allowed_features: authenticated ? ["observability.requests"] : [],
      migration_registry: [
        {
          feature_id: "observability.requests",
          title: "요청 탐색기",
          app_path: "/app/observability/requests",
          legacy_path: "/admin#/requests",
          status: "preview_read_only",
          risk_level: "low",
          required_permission: "admin:read",
          read_only: true,
          enabled_roles: ["super_admin", "admin", "readonly_admin"],
          rollout_percent: 100,
          fallback_enabled: true,
          minimum_api_version: "v0.83.0",
          available: authenticated,
        },
      ],
      system_status: { status: "healthy" },
      legacy_route_map: { "/app/observability/requests": "/admin#/requests" },
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
    const json = (body: unknown, status = 200, requestId = "public-flow-query") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: {
          "X-Request-ID": requestId,
          "Cache-Control": "no-store",
          "X-Vibe-App-Requests-Version": String(contractVersion),
        },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: requestAccount.email, password: "public-password" });
      sessions.add("Bearer public-flow-access");
      return json({
        access_token: "public-flow-access",
        refresh_token: "public-flow-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    const authenticated =
      authenticationMode === "open" || sessions.has(request.headers().authorization ?? "");
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (call === "POST /auth/logout") {
        sessions.clear();
        return json({ status: "ok" });
      }
      if (call === "GET /auth/me") return json({ user });
      if (request.method() !== "GET") writes.push(call);
      if (call === "GET /admin/requests") {
        const sequence = ++listReads;
        listCalls.push(url);
        const reply = listReplies.get(sequence) ?? {
          body: {
            requests: rows.map((row) =>
              contractVersion === 2
                ? structuredClone(row)
                : Object.fromEntries(
                    Object.entries(row).filter(
                      ([key]) => !["request_ref", "request_filterable", "trace_filterable"].includes(key),
                    ),
                  ),
            ),
            limit: Number(url.searchParams.get("limit") ?? 50),
            generated_at: "2026-10-01T00:00:03Z",
          },
        };
        await holds.get(`list:${sequence}`)?.promise;
        return json(reply.body, reply.status, reply.requestId);
      }
      if (call === "GET /admin/app/request-flow") {
        calls.push({ url, headers: request.headers() });
        const sequence = calls.length;
        expect([...url.searchParams.keys()].sort()).toEqual(["created_at", "request_ref"]);
        expect(request.headers()["x-vibe-route"]).toBe("observability.requests");
        const row = rows.find(
          (item) =>
            item.request_ref === url.searchParams.get("request_ref") &&
            item.created_at === url.searchParams.get("created_at"),
        );
        if (!row) throw new Error("Unknown synthetic request reference");
        expect(url.searchParams.get("created_at")).toBe(row.created_at);
        // Capture before a hold so stale responses genuinely retain the old data.
        const reply = structuredClone(replies.get(sequence) ?? { body: safeFlow(row) });
        await holds.get(`flow:${sequence}`)?.promise;
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
    calls,
    finished,
    unexpected,
    writes,
    listReads: () => listReads,
    listCalls,
    contract: (version: 1 | 2) => {
      contractVersion = version;
    },
    team: (team_id: string) => {
      user = { ...user, team_id };
    },
    rows: (next: typeof rows) => {
      rows = structuredClone(next);
    },
    reply: (sequence: number, next: Reply) => replies.set(sequence, next),
    listReply: (sequence: number, next: Reply) => listReplies.set(sequence, next),
    readable: (allowed: boolean) => {
      user = { ...user, scopes: allowed ? [...requestAccount.scopes] : [] };
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
      if (mode === "legacy_token") sessions.add("Bearer public-flow-legacy");
    },
    holdFlow: (sequence: number) => hold("flow", sequence),
    holdList: (sequence: number) => hold("list", sequence),
    releaseFlow: (sequence: number) => holds.get(`flow:${sequence}`)?.release(),
    releaseList: (sequence: number) => holds.get(`list:${sequence}`)?.release(),
    releaseAll: () => {
      for (const item of holds.values()) item.release();
    },
  };
}
export type RequestFlowGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: RequestFlowGateway }>({
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
