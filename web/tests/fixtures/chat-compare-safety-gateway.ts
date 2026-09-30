import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic transport only. The real authenticated Go contract and loopback
// model tests are separate; this fixture never calls a model or enforces UI flags.
export const chatUrl = "/app/gateway/chat?tab=compare";
export const providersUrl = "/app/gateway/providers";
export const firstEmail = "compare-one@example.invalid";
export const secondEmail = "compare-two@example.invalid";
export const promptA = "공개 질문 A의 결과를 요약하세요.";
export const promptB = "아직 실행하지 않은 공개 질문 B입니다.";
export const promptC = "새 비교 실행의 공개 질문 C입니다.";
export const modelA = "public-model-a";
export const modelC = "public-model-c";
export const readonlyReason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
export type Mode = "writable" | "read_only" | "preview_read_only";
export type Action =
  "run" | "judge" | "feedback" | "promote" | "golden" | "predict" | "code" | "diff" | "export";
export const basePath = "/admin/chat-test/multi-run";
export const runPath = (id: string, action: string) => `${basePath}/runs/${id}/${action}`;
const timestamp = "2026-09-30T01:00:00Z";
const userFor = (email: string, write: boolean, read: boolean) => ({
  id: email === secondEmail ? "compare-two" : "compare-one",
  email,
  name: "합성 비교 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-team",
  scopes: [...(read ? ["admin:read"] : []), ...(write ? ["admin:write"] : [])],
  features: { "gateway.chat": true, "gateway.providers": true },
});
type User = ReturnType<typeof userFor>;
export type Operation = { action: Action; path: string; body: Record<string, unknown>; userId: string };
function bootstrap(user: User | undefined, mode: Mode, raw: boolean): UiBootstrapResponse {
  return {
    backend_version: "v0.86.22",
    ui_version: "compare-safety-fixture",
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
    capabilities: { raw_prompt_view: raw },
    migration_registry: [
      {
        feature_id: "gateway.chat",
        title: "채팅 테스트",
        app_path: "/app/gateway/chat",
        legacy_path: "/admin#/chat-test",
        status: mode === "preview_read_only" ? "preview_read_only" : "preview",
        read_only: mode === "read_only",
      },
      {
        feature_id: "gateway.providers",
        title: "AI 공급자",
        app_path: providersUrl,
        legacy_path: "/admin#/settings",
        status: "preview_read_only",
        read_only: true,
      },
    ].map((feature) => ({
      ...feature,
      status: feature.status as "preview" | "preview_read_only",
      risk_level: "medium",
      required_permission: "admin:read",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.86.10",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { "/app/gateway/chat": "/admin#/chat-test", [providersUrl]: "/admin#/settings" },
  };
}

async function install(context: BrowserContext) {
  let mode: Mode = "writable",
    write = true,
    read = true,
    raw = true,
    logins = 0,
    runNumber = 0,
    historyStatus = 200;
  const sessions = new Map<string, User>();
  const operations: Operation[] = [],
    finished: Action[] = [],
    reads: string[] = [],
    unexpected: string[] = [];
  const statuses = new Map<Action, number>();
  const gates = new Map<Action, Promise<void>>(),
    releases = new Map<Action, () => void>();
  const runs: Record<string, unknown>[] = [];
  const release = (key: Action) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method(),
      call = `${method} ${path}`;
    const session = sessions.get(request.headers().authorization ?? "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-compare-safety" },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "Synthetic origin only" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, write, read),
        token = `public-compare-access-${++logins}`;
      sessions.set(`Bearer ${token}`, user);
      return json({
        access_token: token,
        refresh_token: `public-compare-refresh-${logins}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session, mode, raw));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({ version: "v0.86.22", auth_enabled: true, ...(session ? { user: session } : {}) });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (path.startsWith("/v1/") || path.startsWith("/mcp")) {
      unexpected.push(`runtime ${call}`);
      return json({ error: { message: "Real execution forbidden" } }, 501);
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
    if (method === "GET") {
      reads.push(call);
      if (path === `${basePath}/runs`)
        return historyStatus === 200
          ? json({ runs })
          : json({ error: { message: "Synthetic history failure" } }, historyStatus);
      if (path === "/admin/chat-test/targets") return json({ targets: [], defaults: { model: "vibe/auto" } });
      if (path === "/admin/providers") return json({ providers: [] });
      if (path === "/admin/providers/slo") return json({ slos: [], evaluations: [], since: timestamp });
      if (path === "/admin/routing/health")
        return json({
          since: timestamp,
          until: timestamp,
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
            instance_id: "public-compare",
          },
        });
    }
    const match = path.match(
      /^\/admin\/chat-test\/multi-run\/runs\/([^/]+)\/(feedback|promote|golden|code-verify|diff|export)$/u,
    );
    const action: Action | undefined =
      method === "POST" && path === basePath
        ? "run"
        : method === "POST" && path === `${basePath}/judge`
          ? "judge"
          : method === "POST" && path === `${basePath}/predict`
            ? "predict"
            : match
              ? match[2] === "code-verify"
                ? "code"
                : (match[2] as Action)
              : undefined;
    if (!action || method !== (["code", "diff", "export"].includes(action) ? "GET" : "POST")) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic request" } }, 501);
    }
    const body = method === "POST" ? (request.postDataJSON() as Record<string, unknown>) : {};
    // Count before responding. No scope or readonly rejection can disguise an
    // escaped UI operation. These public markers are not real credentials.
    operations.push({ action, path, body: structuredClone(body), userId: session.id });
    expect(request.headers()["x-vibe-ui"]).toBe("app");
    const status = statuses.get(action) ?? 200;
    let id = match?.[1] ?? String(body.run_id ?? "");
    const model = String(body.model ?? body.selected_model ?? modelA);
    let response: unknown;
    if (action === "run") {
      id = `public-run-${++runNumber}`;
      const models = body.models as { model: string; provider?: string }[];
      response = {
        status: "completed",
        run_id: id,
        title: body.title ?? "",
        summary: {
          total_models: models.length,
          success: models.length,
          failed: 0,
          best_latency_model: models[0]?.model,
          lowest_cost_success_model: models[0]?.model,
        },
        results: models.map((item) => ({
          model: item.model,
          provider: item.provider ?? "",
          status: "success",
          status_code: 200,
          latency_ms: 12,
          input_tokens: 8,
          output_tokens: 10,
          total_tokens: 18,
          cost_krw_est: 0.1,
          content: `공개 비교 응답 ${id}`,
          finish_reason: "stop",
          error: "",
          selected_provider: "public-provider",
        })),
      };
      if (status === 200)
        runs.unshift({
          id,
          title: body.title ?? "",
          created_by: session.id,
          team: "public-team",
          prompt_hash: "a".repeat(64),
          prompt_preview: "",
          model_count: models.length,
          success: models.length,
          failed: 0,
          created_at: timestamp,
        });
    } else if (action === "predict")
      response = {
        input_tokens: 8,
        total_cost_krw: 0.2,
        priced_models: 1,
        note: "공개 합성 계산",
        estimates: [
          {
            model: modelA,
            cost_krw: 0.2,
            priced: true,
            input_tokens: 8,
            output_tokens: 10,
            latency_ms: 12,
            basis: "history",
          },
        ],
      };
    else if (action === "judge")
      response = {
        run_id: id,
        method: body.method ?? "rule",
        best_model: modelA,
        note: "공개 합성 평가",
        weights: { accuracy: 0.3, completeness: 0.25, format: 0.15, safety: 0.2, cost: 0.1 },
        judgements: [
          {
            id: "public-judgement",
            run_id: id,
            model: modelA,
            method: body.method ?? "rule",
            judge_model: body.judge_model ?? "",
            rubric: "public-rubric",
            accuracy: 80,
            completeness: 80,
            format_score: 80,
            safety: 80,
            cost_efficiency: 80,
            total_score: 80,
            verdict: "pass",
            reason_summary: "공개 합성 평가",
            response_hash: "b".repeat(64),
            created_by: session.id,
            // Store receives values, so this response retains the legacy empty timestamp.
            created_at: "",
          },
        ],
      };
    else if (action === "feedback") response = { status: "recorded", run_id: id, model };
    else if (action === "promote")
      response = {
        status: "draft_saved",
        note: "Routing draft only",
        promotion: {
          id: "public-promotion",
          run_id: id,
          selected_model: model,
          task_type: body.task_type ?? "",
          reason: body.reason,
          status: "draft",
          created_by: session.id,
          created_at: "",
        },
      };
    else if (action === "golden")
      response = {
        status: "saved",
        workflow_id: body.workflow_id ?? "public-workflow",
        workflow_name: body.workflow_name ?? "공개 워크플로",
        step_name: body.step_name ?? `step-${model}`,
        step_count: 1,
        baseline_score: 0,
      };
    else if (action === "code")
      response = {
        run_id: id,
        note: "공개 정적 코드 검사",
        models_with_code: 0,
        leaderboard: [
          {
            rank: 1,
            model: modelA,
            available: true,
            risk: "none",
            has_code: false,
            block_count: 0,
            languages: [],
            counts: {},
            score: 50,
          },
        ],
        per_model: [
          {
            model: modelA,
            available: true,
            score: 50,
            report: {
              has_code: false,
              block_count: 0,
              languages: [],
              risk: "none",
              counts: {},
              blocks: [],
              note: "공개 정적 검사",
            },
          },
        ],
        scoring_breakdown: "공개 합성 정적 계산",
      };
    else if (action === "diff")
      response = {
        run_id: id,
        answered_models: 1,
        note: "공개 저장 응답 비교",
        common_blocks: [],
        models: [
          {
            model: modelA,
            blocks: [],
            stats: {
              available: true,
              paragraphs: 1,
              list_items: 0,
              code_blocks: 0,
              chars: 12,
              lines: 1,
              has_table: false,
              has_code: false,
            },
          },
        ],
        per_model: [
          {
            model: modelA,
            available: true,
            block_count: 1,
            missing: [],
            extra: [],
            stats: {
              available: true,
              paragraphs: 1,
              list_items: 0,
              code_blocks: 0,
              chars: 12,
              lines: 1,
              has_table: false,
              has_code: false,
            },
          },
        ],
      };
    await gates.get(action);
    try {
      if (status !== 200)
        return await json(
          {
            error: {
              message: "Synthetic operation unavailable",
              type: "server_error",
              code: "synthetic_failure",
            },
          },
          status,
        );
      if (action === "export")
        return await route.fulfill({
          status: 200,
          contentType: "text/markdown",
          headers: { "X-Request-ID": "req-compare-safety" },
          body: `# 공개 실행 ${id}\n합성 응답 내보내기\n`,
        });
      return await json(response);
    } finally {
      finished.push(action);
    }
  });
  const updateScopes = () => {
    for (const user of sessions.values()) user.scopes = userFor(user.email, write, read).scopes;
  };
  return {
    operations,
    finished,
    reads,
    unexpected,
    count: (action: Action) => operations.filter((item) => item.action === action).length,
    setMode: (value: Mode) => {
      mode = value;
    },
    setWrite: (value: boolean) => {
      write = value;
      updateScopes();
    },
    setRead: (value: boolean) => {
      read = value;
      updateScopes();
    },
    setRaw: (value: boolean) => {
      raw = value;
    },
    setStatus: (action: Action, value: number) => {
      statuses.set(action, value);
    },
    setHistoryStatus: (value: number) => {
      historyStatus = value;
    },
    hold: (action: Action) => {
      gates.set(action, new Promise<void>((resolve) => releases.set(action, resolve)));
    },
    release,
    releaseAll: () => {
      for (const action of [...gates.keys()]) release(action);
    },
  };
}
export type CompareGateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: CompareGateway }>({
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
