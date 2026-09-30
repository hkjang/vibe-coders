import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic transport for the actual LLM detail/disclosure caller. No Go auth,
// raw Trace Explorer linkage, storage, exact stage timing or server masking proof.
export const targetUrl = "/app/observability/llm?tab=evaluations";
export const firstId = "flow-public-request-a";
export const secondId = "flow-public-request-b";
export const email = "flow-reader@example.invalid";
export const rootName = "공개 요청 모델";
export const toolName = "공개 문서 검색 도구";
export const sessionId = "flow-public-session";
export const timestamp = "2026-10-01T00:00:00Z";
export type Mode = "preview" | "read_only" | "preview_read_only";
export type Kind = "trace" | "links";
export function rootSpan(overrides: Record<string, unknown> = {}, id = firstId) {
  return {
    span_id: `span:req:${id}`,
    parent_span_id: "",
    name: rootName,
    kind: "request",
    status: "ok",
    start_offset_ms: 0,
    duration_ms: 120,
    ...overrides,
  };
}
export function toolSpan(overrides: Record<string, unknown> = {}, id = firstId) {
  return {
    span_id: "span:tool:public-tool",
    parent_span_id: `span:req:${id}`,
    name: toolName,
    kind: "mcp_tool",
    status: "ok",
    start_offset_ms: 0,
    duration_ms: 0,
    ...overrides,
  };
}
export function traceResult(overrides: Record<string, unknown> = {}, id = firstId) {
  return {
    request_id: id,
    trace_id: "flow-public-trace",
    total_ms: 120,
    spans: [rootSpan({}, id), toolSpan({}, id)],
    ...overrides,
  };
}
export function linksResult(overrides: Record<string, unknown> = {}, id = firstId) {
  return {
    request_id: id,
    trace_id: "flow-public-trace",
    session_id: sessionId,
    counts: { tools: 1, mcp_tools: 1, text2sql_spans: 0, tool_errors: 0 },
    governance: { blocked: false },
    ...overrides,
  };
}
const user = {
  id: "flow-reader",
  email,
  name: "합성 처리 흐름 조회자",
  role: "readonly_admin",
  roles: ["readonly_admin"],
  scopes: ["admin:read"],
  team_id: "flow-public-team",
  features: { "observability.llm": true, "observability.xview": true },
};
function bootstrap(authenticated: boolean, mode: Mode, prefixes: string[]): UiBootstrapResponse {
  return {
    backend_version: "v0.86.28",
    ui_version: "request-flow-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: targetUrl,
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated,
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
      credential_prefixes: prefixes,
    },
    ...(authenticated ? { user } : {}),
    roles: authenticated ? user.roles : [],
    permissions: authenticated ? user.scopes : [],
    allowed_features: authenticated ? ["observability.llm", "observability.xview"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "observability.llm",
        title: "LLM 관측",
        app_path: "/app/observability/llm",
        legacy_path: "/admin#/llm",
      },
      {
        feature_id: "observability.xview",
        title: "XView 실시간",
        app_path: "/app/observability/xview",
        legacy_path: "/admin#/xview",
      },
    ].map((feature) => ({
      ...feature,
      status: mode === "preview_read_only" ? "preview_read_only" : "preview",
      read_only: mode === "read_only",
      required_permission: "admin:read",
      risk_level: "low",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.84.0",
      available: authenticated,
    })),
    system_status: { status: "healthy" },
    legacy_route_map: {
      "/app/observability/llm": "/admin#/llm",
      "/app/observability/xview": "/admin#/xview",
    },
  };
}
type Reply = { status?: number; body?: Record<string, unknown>; requestId?: string };
type Plan = Reply & { gate?: Promise<void>; release?: () => void };
async function install(context: BrowserContext) {
  let mode: Mode = "preview";
  let prefixes = ["vc_sk_", "vc_sa_"];
  const sessions = new Set<string>();
  const attempts: { kind: Kind; sequence: number; id: string; method: string; path: string }[] = [];
  const unexpected: string[] = [];
  const finished = new Set<string>();
  const defaults: Record<Kind, Reply> = { trace: {}, links: {} };
  const plans = new Map<string, Plan>();
  const count = (kind: Kind) => attempts.filter((item) => item.kind === kind).length;
  const reads: Record<string, unknown> = {
    "GET /admin/llm/timeseries": { window: "24h", bucket: "hour", since: timestamp, points: [] },
    "GET /admin/llm/evaluations": {
      summary: [],
      evaluations: [firstId, secondId].map((request_id) => ({
        id: `eval-${request_id}`,
        request_id,
        trace_id: "flow-public-trace",
        name: "공개 품질 평가",
        score: 0.5,
        label: "확인",
        passed: false,
        created_at: timestamp,
      })),
    },
    "GET /admin/llm/feedback": { feedback: [] },
    "GET /admin/saved-filters": { filters: [] },
    "GET /admin/scatter": {
      points: [],
      groups: [],
      truncated: false,
      since: timestamp,
      cursor: { ingested_at: timestamp, request_id: firstId },
      server_time: timestamp,
    },
    "GET /admin/xview/delta": {
      points: [],
      cursor: { ingested_at: timestamp, request_id: firstId },
      has_more: false,
      server_time: timestamp,
    },
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const call = `${request.method()} ${path}`;
    const authenticated = sessions.has(request.headers().authorization ?? "");
    const json = (body: unknown, status = 200, requestId = "flow-public-response") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "External requests are not part of this fixture" } }, 501);
    }
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email, password: "public-test-password" });
      const token = `public-flow-token-${sessions.size + 1}`;
      sessions.add(`Bearer ${token}`);
      return json({
        access_token: token,
        refresh_token: "public-flow-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated, mode, prefixes));
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.28",
        auth_enabled: true,
        credential_prefixes: prefixes,
        ...(authenticated ? { user } : {}),
      });
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (!/^\/(admin|auth|me|team|v1|mcp)(?:\/|$)/u.test(path)) return route.continue();

    const flow = /^\/admin\/requests\/([^/]+)\/(trace|links)$/u.exec(path);
    if (flow) {
      const kind = flow[2] as Kind;
      const id = decodeURIComponent(flow[1] ?? "");
      const sequence = count(kind) + 1;
      // Admission is recorded before response selection or validation. The fixture
      // never enforces feature readonly, prefix display protection or UI retry rules.
      attempts.push({ kind, sequence, id, method: request.method(), path });
      expect(request.method()).toBe("GET");
      expect(request.postData()).toBeNull();
      expect(authenticated).toBe(true);
      expect([firstId, secondId]).toContain(id);
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      const key = `${kind}:${sequence}`;
      const plan = plans.get(key) ?? defaults[kind];
      const body = structuredClone(
        plan.body ?? (kind === "trace" ? traceResult({}, id) : linksResult({}, id)),
      );
      const status = plan.status ?? 200;
      const responseId = plan.requestId ?? `flow-${kind}-response`;
      await ("gate" in plan ? plan.gate : undefined);
      try {
        return await json(
          status === 200
            ? body
            : {
                error: {
                  message: "Synthetic flow read unavailable",
                  type: "server_error",
                  code: "synthetic_flow_read",
                },
              },
          status,
          responseId,
        );
      } finally {
        finished.add(key);
      }
    }
    if (!authenticated) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    const detail = /^\/admin\/llm\/traces\/([^/]+)$/u.exec(path);
    if (detail && request.method() === "GET" && [firstId, secondId].includes(detail[1] ?? ""))
      return json({
        request: {
          id: detail[1],
          trace_id: "flow-public-trace",
          session_id: sessionId,
          model: "공개 상세 모델",
          provider: "public-provider",
          status_code: 200,
          created_at: timestamp,
          latency_ms: 120,
          first_chunk_ms: 40,
          total_tokens: 50,
          estimated_cost: 1,
        },
        spans: [],
        tools: [],
        evaluations: [],
        feedback: [],
      });
    const supporting = /^\/admin\/requests\/([^/]+)\/(explain|note)$/u.exec(path);
    if (supporting && request.method() === "GET" && [firstId, secondId].includes(supporting[1] ?? ""))
      return json(
        supporting[2] === "note"
          ? {
              request_id: supporting[1],
              note: "",
              tags: [],
              created_by: "",
              updated_at: timestamp,
              exists: false,
              redacted_fields: [],
            }
          : {
              request_id: supporting[1],
              trace_id: "flow-public-trace",
              created_at: timestamp,
              routing: { chosen_provider: "public-provider", chosen_model: "공개 상세 모델" },
              cache: {},
              evaluation: {},
              governance: {},
              text2sql: {},
              cost: {},
              session: { session_id: sessionId },
            },
      );
    if (Object.hasOwn(reads, call)) return json(reads[call]);
    unexpected.push(call);
    return json({ error: { message: "Unexpected request-flow fixture request" } }, 501);
  });
  return {
    attempts,
    unexpected,
    finished,
    count,
    setMode: (next: Mode) => {
      mode = next;
    },
    setPrefixes: (next: readonly string[]) => {
      prefixes = [...next];
    },
    setReply: (kind: Kind, reply: Reply) => {
      defaults[kind] = structuredClone(reply);
    },
    hold: (kind: Kind, sequence: number, reply: Reply = {}) => {
      const key = `${kind}:${sequence}`;
      if (sequence <= count(kind) || plans.has(key)) throw new Error("Hold must precede a unique request");
      const plan: Plan = { ...structuredClone(reply) };
      plan.gate = new Promise<void>((resolve) => {
        plan.release = resolve;
      });
      plans.set(key, plan);
    },
    release: (kind: Kind, sequence: number) => {
      plans.get(`${kind}:${sequence}`)?.release?.();
    },
    releaseAll: () => {
      for (const plan of plans.values()) plan.release?.();
    },
  };
}
export type FlowGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: FlowGateway }>({
  gateway: async ({ context }, provide) => {
    const gateway = await install(context);
    try {
      await provide(gateway);
    } finally {
      gateway.releaseAll();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
