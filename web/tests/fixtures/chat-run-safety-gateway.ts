import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic API evidence only: hold/fulfill returns a buffered SSE body, not
// network-progressive chunks. Controlled ReadableStream unit tests separately
// cover incremental delivery. No external model or real Go authorization runs.
export const chatUrl = "/app/gateway/chat";
export const providersUrl = "/app/gateway/providers";
export const firstEmail = "chat-one@example.invalid";
export const secondEmail = "chat-two@example.invalid";
export const readonlyReason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
export const publicAnswer = "합성 모델의 공개 응답입니다.";
export const publicReasoning = "공개 합성 추론입니다.";
export const publicPrompt = "공개 합성 질문입니다.";
export const publicModel = "browser-chat-model";
export type Mode = "writable" | "read_only" | "preview_read_only";
export type Action = "stream" | "preview" | "code";
export const paths = {
  targets: "/admin/chat-test/targets",
  stream: "/admin/chat-test/stream",
  preview: "/admin/routing/preview",
  code: "/admin/code-verify",
} as const;
const userFor = (email: string, write: boolean, preview: boolean) => ({
  id: email === secondEmail ? "chat-two" : "chat-one",
  email,
  name: "합성 호출 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "fixture-team",
  scopes: ["admin:read", ...(write ? ["admin:write"] : []), ...(preview ? ["routing:read"] : [])],
  features: { "gateway.chat": true, "gateway.providers": true },
});
type User = ReturnType<typeof userFor>;
type Operation = { action: Action; body: Record<string, unknown>; userId: string };
function bootstrap(user: User | undefined, mode: Mode): UiBootstrapResponse {
  return {
    backend_version: "v0.86.21",
    ui_version: "chat-run-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: chatUrl,
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated: Boolean(user),
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    ...(user ? { user } : {}),
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["gateway.chat", "gateway.providers"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "gateway.chat",
        title: "채팅 테스트",
        app_path: chatUrl,
        legacy_path: "/admin#/chat-test",
        status: mode === "preview_read_only" ? ("preview_read_only" as const) : ("preview" as const),
        read_only: mode === "read_only",
      },
      {
        feature_id: "gateway.providers",
        title: "AI 공급자",
        app_path: providersUrl,
        legacy_path: "/admin#/settings",
        status: "preview_read_only" as const,
        read_only: true,
      },
    ].map((feature) => ({
      ...feature,
      risk_level: "medium",
      required_permission: "admin:read",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.86.10",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { [chatUrl]: "/admin#/chat-test", [providersUrl]: "/admin#/settings" },
  };
}
export function sseBody(content = publicAnswer) {
  return (
    [
      { choices: [{ delta: { reasoning_content: publicReasoning } }] },
      { choices: [{ delta: { content } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}
async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    write = true,
    preview = true,
    logins = 0,
    targetsStatus = 200;
  const sessions = new Map<string, User>();
  const operations: Operation[] = [],
    finished: Action[] = [],
    reads: string[] = [],
    unexpected: string[] = [];
  const status: Record<Action, number> = { stream: 200, preview: 200, code: 200 };
  const payloads = new Map<Action, unknown>();
  const gates = new Map<string, Promise<void>>(),
    releases = new Map<string, () => void>();
  const release = (key: string) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const call = `${request.method()} ${path}`,
      session = sessions.get(request.headers().authorization ?? "");
    const json = (body: unknown, code = 200) =>
      route.fulfill({
        status: code,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-chat-safety" },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external-origin ${call}`);
      return json({ error: { message: "Synthetic chat forbids external requests" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, write, preview),
        access = `public-chat-access-${++logins}`;
      sessions.set(`Bearer ${access}`, user);
      return json({
        access_token: access,
        refresh_token: `public-chat-refresh-${logins}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({ version: "v0.86.21", auth_enabled: true, ...(session ? { user: session } : {}) });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (path.startsWith("/v1/") || path.startsWith("/mcp")) {
      unexpected.push(`external-or-runtime ${call}`);
      return json({ error: { message: "Synthetic chat forbids real execution" } }, 501);
    }
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/")) return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      sessions.delete(request.headers().authorization ?? "");
      return json({ status: "logged_out" });
    }
    if (request.method() === "GET") {
      reads.push(call);
      if (path === paths.targets) {
        const responseStatus = targetsStatus;
        await gates.get("targets");
        return responseStatus === 200
          ? json({
              targets: [
                {
                  id: "public-chat-target",
                  kind: "provider",
                  label: "공개 합성 대상",
                  model: publicModel,
                  provider: "public-provider",
                  enabled: true,
                },
              ],
              defaults: { model: "vibe/auto" },
            })
          : json({ error: { message: "Synthetic targets unavailable" } }, responseStatus);
      }
      if (path === "/admin/providers") return json({ providers: [] });
      if (path === "/admin/providers/slo")
        return json({ slos: [], evaluations: [], since: "2026-09-30T01:00:00Z" });
      if (path === "/admin/routing/health")
        return json({
          since: "2026-09-30T00:00:00Z",
          until: "2026-09-30T01:00:00Z",
          threshold: 70,
          providers: [],
          ranking: [],
          degraded: [],
          alerts: [],
          trend: [],
          breakers: {
            enabled: false,
            threshold: 3,
            cooldown_seconds: 30,
            states: [],
            shared: false,
            instance_id: "public-chat-fixture",
          },
        });
      if (path === "/admin/model-tags") return json({ tags: [] });
    }
    const action = (["stream", "preview", "code"] as const).find((candidate) => paths[candidate] === path);
    if (request.method() === "POST" && action) {
      const body = request.postDataJSON() as Record<string, unknown>;
      // Record first; neither runtime readonly nor API scope is enforced here.
      // UI guard evidence must not pass because a fixture rejected the request.
      operations.push({ action, body: structuredClone(body), userId: session.id });
      const responseStatus = status[action];
      const response = payloads.has(action)
        ? structuredClone(payloads.get(action))
        : action === "stream"
          ? sseBody()
          : action === "preview"
            ? {
                requested_model: String(body.model ?? "vibe/auto"),
                selected_model: publicModel,
                selected_provider: "public-provider",
                would_rewrite: true,
                decision_reason: "공개 합성 경로 계산",
                fallback_plan: [],
                complexity: 0.3,
                risk: 0.1,
                health_score: 100,
              }
            : {
                has_code: false,
                block_count: 0,
                languages: [],
                risk: "none",
                counts: {},
                blocks: [],
                note: "공개 합성 정적 검사",
              };
      await gates.get(action);
      try {
        if (responseStatus !== 200)
          return await json({ error: { message: "Synthetic operation unavailable" } }, responseStatus);
        if (action !== "stream") return await json(response);
        return await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: {
            "X-Request-ID": "req-chat-safety",
            "X-Public-Diagnostic": "public-diagnostic",
            "X-Api-Key": "synthetic-header-must-not-render",
          },
          body: String(response),
        });
      } finally {
        // Fulfillment attempted; an aborted browser fetch need not receive it.
        finished.push(action);
      }
    }
    unexpected.push(call);
    return json({ error: { message: "Unexpected synthetic chat request" } }, 501);
  });
  const updateScopes = () => {
    for (const user of sessions.values()) user.scopes = userFor(user.email, write, preview).scopes;
  };
  return {
    operations,
    finished,
    reads,
    unexpected,
    count: (action: Action) => operations.filter((operation) => operation.action === action).length,
    setMode: (value: Mode) => {
      mode = value;
    },
    setWriteScope: (value: boolean) => {
      write = value;
      updateScopes();
    },
    setPreviewScope: (value: boolean) => {
      preview = value;
      updateScopes();
    },
    setStatus: (action: Action, value: number) => {
      status[action] = value;
    },
    setPayload: (action: Action, value: unknown) => {
      payloads.set(action, value);
    },
    setTargetsStatus: (value: number) => {
      targetsStatus = value;
    },
    hold: (key: string) => {
      gates.set(key, new Promise<void>((resolve) => releases.set(key, resolve)));
    },
    release,
    releaseAll: () => {
      for (const key of [...gates.keys()]) release(key);
    },
  };
}
export type ChatGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: ChatGateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await install(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseAll();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
