import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Real browser AuthProvider/ApiClient with public synthetic HTTP only. This does
// not execute Go authorization, database scoping, masking, or write persistence.
export const targetUrl = "/app/observability/llm?tab=evaluations";
export const requestA = "public-browser-team-a-request";
export const requestB = "public-browser-team-b-request";
export const detailPath = `/admin/llm/traces/${requestA}`;
export const notePath = `/admin/requests/${requestA}/note`;
export const feedbackPath = "/admin/llm/feedback";
export const loginEmail = "public-browser-operator@example.invalid";
export const replacement = "브라우저에만 보관하는 합성 사용자 초안";
const timestamp = "2026-10-08T08:59:30Z";
type Role = "admin" | "readonly_admin" | "team_admin" | "public_llm_operator";
type Identity = { id: string; role: Role; team: string; writable: boolean };
type Call = { method: string; path: string; status?: number };

function gate() {
  let pending: Promise<void> | undefined;
  let resolve: (() => void) | undefined;
  return {
    hold: () => {
      pending = new Promise<void>((done) => {
        resolve = done;
      });
    },
    release: () => {
      resolve?.();
      pending = undefined;
    },
    wait: () => pending,
  };
}

async function installGateway(context: BrowserContext) {
  const identity: Identity = {
    id: "public-browser-owner-a",
    role: "admin",
    team: "public-team-a",
    writable: true,
  };
  const tokens = new Set<string>();
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const noteGate = gate(),
    feedbackGate = gate();
  let revision = 0,
    generation = 0,
    expirePath = "",
    restrictedRequest = false;
  let noteStatus = 200,
    backendReadable = true,
    featureReadOnly = false;
  let feedbackStatus = 201,
    feedbackReceipts = 0;
  const raw = () => identity.role === "admin";
  const currentId = () =>
    identity.role === "team_admin" && identity.team === "public-team-b" ? requestB : requestA;
  const projection = (field: string) =>
    raw()
      ? `public-${generation === 0 ? "old" : "fresh"}-${field}@example.invalid`
      : identity.role === "readonly_admin"
        ? "[REDACTED_EMAIL]"
        : `public-${identity.team}-${generation}-${field}`;
  const user = () => ({
    id: identity.id,
    email: loginEmail,
    name: identity.id,
    role: identity.role,
    roles: [identity.role],
    team_id: identity.team,
    scopes: ["admin:read", ...(identity.writable ? ["admin:write"] : [])],
    features: { "observability.llm": true },
  });
  const issue = () => {
    revision += 1;
    const access = `public-browser-access-${revision}`;
    tokens.add(`Bearer ${access}`);
    return {
      access_token: access,
      refresh_token: `public-browser-refresh-${revision}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_expires_in: 7200,
      user: user(),
    };
  };
  const bootstrap = (authenticated: boolean): UiBootstrapResponse => ({
    backend_version: "v0.86.45",
    ui_version: "llm-read-owner-browser-fixture",
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
      credential_prefixes: ["vc_sk_", "vc_sa_"],
    },
    ...(authenticated ? { user: user() } : {}),
    roles: authenticated ? [identity.role] : [],
    permissions: authenticated ? user().scopes : [],
    allowed_features: authenticated ? ["observability.llm"] : [],
    capabilities: { raw_prompt_view: authenticated && raw() },
    migration_registry: [
      {
        feature_id: "observability.llm",
        title: "LLM 관측",
        app_path: "/app/observability/llm",
        legacy_path: "/admin#/llm",
        status: "preview",
        risk_level: "low",
        read_only: featureReadOnly,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        required_permission: "admin:read",
        minimum_api_version: "v0.84.0",
        available: authenticated,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/observability/llm": "/admin#/llm" },
  });
  const note = (id = currentId()) => ({
    request_id: id,
    note: projection("note"),
    tags: ["public-server-tag"],
    created_by: "public-operator",
    updated_at: timestamp,
    exists: true,
    redacted_fields: identity.role === "readonly_admin" ? ["note"] : [],
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (
      !path.startsWith("/admin/") &&
      !path.startsWith("/auth/") &&
      !path.startsWith("/me/") &&
      !["/health", "/ready"].includes(path)
    )
      return route.continue();
    const call: Call = { method, path };
    calls.push(call);
    const reply = async (body: unknown, status = 200) => {
      call.status = status;
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "public-llm-browser-receipt" },
        body: JSON.stringify(body),
      });
    };
    const authenticated = tokens.has(request.headers().authorization ?? "");
    if (method === "POST" && path === "/auth/login") {
      expect(request.postDataJSON()).toEqual({ email: loginEmail, password: "public-test-password" });
      return reply(issue());
    }
    if (method === "POST" && path === "/auth/refresh") return reply(issue());
    if (method === "GET" && path === "/auth/sso/status")
      return reply({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (method === "GET" && path === "/health") return reply({ status: "ok" });
    if (method === "GET" && path === "/ready") return reply({ status: "ready" });
    if (method === "GET" && path === expirePath) {
      expirePath = "";
      return reply({ error: { message: "Expired synthetic access", type: "authentication_error" } }, 401);
    }
    if (method === "GET" && path === "/admin/ui-bootstrap") return reply(bootstrap(authenticated));
    if (method === "GET" && path === "/auth/me")
      return reply({
        version: "v0.86.45",
        auth_enabled: true,
        credential_prefixes: ["vc_sk_", "vc_sa_"],
        ...(authenticated ? { user: user() } : {}),
      });
    if (!authenticated) {
      unexpected.push(`unauthenticated ${method} ${path}`);
      return reply({ error: { message: "Synthetic login required" } }, 401);
    }
    if (method === "POST" && path === feedbackPath) {
      writes.push({ method, path, body: request.postDataJSON() });
      const status = feedbackStatus;
      await feedbackGate.wait();
      await reply(
        status === 201
          ? { feedback: { id: "public-feedback", request_id: requestA, rating: 1 } }
          : { error: { message: "Synthetic delayed feedback failure" } },
        status,
      );
      feedbackReceipts += 1;
      return;
    }
    if (method === "PATCH" && path === notePath) {
      writes.push({ method, path, body: request.postDataJSON() });
      return reply(note());
    }
    if (method !== "GET") {
      unexpected.push(`${method} ${path}`);
      return reply({ error: { message: "Unexpected synthetic mutation" } }, 405);
    }
    // Missing admin:read is a terminal401, not a fake parent team-scope403.
    if (!backendReadable)
      return reply(
        { error: { message: "invalid api key", type: "authentication_error", code: "invalid_api_key" } },
        401,
      );
    const single = /^\/admin\/requests\/([^/]+)\/(note|explain|trace|links)$/.exec(path);
    const trace = /^\/admin\/llm\/traces\/([^/]+)$/.exec(path);
    const requestedId = single?.[1] ?? trace?.[1];
    if (requestedId && (restrictedRequest || (identity.role === "team_admin" && requestedId !== currentId())))
      return reply(
        {
          error: {
            message: "request is outside your team scope",
            type: "permission_error",
            code: "cross_team_access_denied",
          },
        },
        403,
      );
    if (single?.[2] === "note") {
      const body = note(requestedId),
        status = noteStatus;
      await noteGate.wait();
      return reply(status === 200 ? body : { error: { message: "Synthetic note read unavailable" } }, status);
    }
    if (trace)
      return reply({
        request: {
          id: requestedId,
          trace_id: "public-trace",
          prompt_name: projection("detail"),
          prompt_version: "v2",
          status_code: 200,
          created_at: timestamp,
        },
        spans: [],
        evaluations: [],
        feedback: [],
        tools: [],
      });
    if (single?.[2] === "explain")
      return reply({ request_id: requestedId, routing: { detail: projection("explain") } });
    if (single?.[2] === "trace") return reply({ request_id: requestedId, spans: [] });
    if (single?.[2] === "links")
      return reply({ request_id: requestedId, counts: {}, governance: { blocked: false } });
    if (path === "/admin/llm/evaluations")
      return reply({
        summary: [],
        evaluations: restrictedRequest
          ? []
          : [
              {
                id: "public-evaluation",
                request_id: currentId(),
                name: "public-quality",
                reason: projection("parent"),
                created_at: timestamp,
              },
            ],
      });
    if (path === "/admin/llm/timeseries") return reply({ points: [] });
    if (path === feedbackPath) return reply({ feedback: [] });
    if (path === "/admin/llm/prompts") return reply({ prompts: [] });
    if (path === "/admin/llm/insights") return reply({ insights: [] });
    if (path === "/admin/llm/patterns") return reply({ patterns: [] });
    unexpected.push(`${method} ${path}`);
    return reply({ error: { message: "Unexpected LLM browser fixture read" } }, 501);
  });
  return {
    calls,
    writes,
    unexpected,
    configure: (next: Partial<Identity>) => Object.assign(identity, next),
    transition: (kind: "role" | "principal" | "team") => {
      if (kind === "role") Object.assign(identity, { role: "readonly_admin", writable: false });
      if (kind === "principal") identity.id = "public-browser-owner-b";
      if (kind === "team") identity.team = "public-team-b";
      generation += 1;
      expirePath = "/admin/ui-bootstrap";
    },
    markers: () =>
      [projection("parent"), projection("detail"), projection("note"), projection("explain")] as const,
    noteValue: () => projection("note"),
    setWritable: (value: boolean) => {
      identity.writable = value;
    },
    setReadOnly: (value: boolean) => {
      featureReadOnly = value;
    },
    setNoteStatus: (status: number) => {
      noteStatus = status;
    },
    // Models the effective access of a refreshed team-B token while the browser
    // still holds its old bootstrap. A real admin is not itself team-restricted.
    // These opaque synthetic tokens do not execute Go's JWT/role machinery.
    denyNextNote: () => {
      restrictedRequest = true;
      expirePath = notePath;
    },
    restoreAccess: () => {
      restrictedRequest = false;
      backendReadable = true;
      generation += 1;
      expirePath = "/admin/llm/evaluations";
    },
    revokeBackendRead: () => {
      backendReadable = false;
    },
    holdNotes: noteGate.hold,
    releaseNotes: noteGate.release,
    holdFeedback: (status = 201) => {
      feedbackStatus = status;
      feedbackGate.hold();
    },
    releaseFeedback: feedbackGate.release,
    feedbackReceipts: () => feedbackReceipts,
  };
}
export type LLMReadOwnerGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: LLMReadOwnerGateway }>({
  gateway: async ({ context }, provideGateway) => {
    const gateway = await installGateway(context);
    try {
      await provideGateway(gateway);
    } finally {
      gateway.releaseNotes();
      gateway.releaseFeedback();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
