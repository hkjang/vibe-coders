import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic FeatureRoute/bootstrap evidence only. Existing server authorization
// and business-side effects are not proved by these browser fixtures.
export type FeatureId = "agents.skills" | "observability.llm" | "observability.xview";
export type Mode = "writable" | "read_only" | "preview_read_only";
export const skillUrl = "/app/agents/skills";
export const llmUrl = "/app/observability/llm?tab=evaluations";
export const xviewUrl = "/app/observability/xview";
export const firstEmail = "readonly-one@example.invalid";
export const secondEmail = "readonly-two@example.invalid";
export const skillName = "readonly-fixture-skill";
export const requestId = "readonly-fixture-request";
export const viewId = "readonly-fixture-view";
export const reason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
const timestamp = "2026-09-30T01:00:00Z";
const initialSkill = {
  name: skillName,
  version: "1.0.0",
  status: "draft",
  risk_level: "high",
  owner: "합성 운영자",
  description: "공개 브라우저 검증",
  instructions: "공개 합성 지침",
  allowed_models: "fixture-model",
  allowed_tools: "fixture-tool",
  allowed_teams: "fixture-team",
  daily_limit: 10,
};
const initialNote = {
  request_id: requestId,
  note: "기존 공개 메모",
  tags: ["합성"],
  exists: true,
  redacted_fields: [] as string[],
  created_by: "합성 운영자",
  updated_at: timestamp,
};
const userFor = (email: string) => ({
  id: email === secondEmail ? "readonly-two" : "readonly-one",
  email,
  name: "읽기 전용 전환 검토자",
  role: "admin",
  roles: ["admin"],
  scopes: ["admin:read", "admin:write"],
  team_id: "fixture-team",
  features: { "agents.skills": true, "observability.llm": true, "observability.xview": true },
});
type User = ReturnType<typeof userFor>;
type Operation = {
  call: string;
  kind: "read" | "compute" | "write" | "execute";
  body: Record<string, unknown> | null;
  userId: string;
};
function gate() {
  let promise: Promise<void> | undefined, release: (() => void) | undefined;
  return {
    hold: () => {
      promise = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
      promise = undefined;
    },
    wait: () => promise,
  };
}
function bootstrap(
  user: User | undefined,
  modes: Record<FeatureId, Mode>,
  raw: boolean,
): UiBootstrapResponse {
  return {
    backend_version: "v0.86.18",
    ui_version: "feature-readonly-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: skillUrl,
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
    allowed_features: user ? Object.keys(modes) : [],
    capabilities: { raw_prompt_view: raw },
    migration_registry: [
      {
        feature_id: "agents.skills" as const,
        title: "스킬",
        app_path: skillUrl,
        legacy_path: "/admin#/skills",
      },
      {
        feature_id: "observability.llm" as const,
        title: "LLM 관측",
        app_path: "/app/observability/llm",
        legacy_path: "/admin#/llm",
      },
      {
        feature_id: "observability.xview" as const,
        title: "XView 실시간",
        app_path: xviewUrl,
        legacy_path: "/admin#/xview",
      },
    ].map((feature) => ({
      ...feature,
      status: modes[feature.feature_id] === "preview_read_only" ? "preview_read_only" : "preview",
      risk_level: "medium",
      read_only: modes[feature.feature_id] === "read_only",
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      required_permission: "admin:read",
      minimum_api_version: "v0.84.0",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { [skillUrl]: "/admin#/skills", [xviewUrl]: "/admin#/xview" },
  };
}
async function installGateway(context: BrowserContext) {
  const modes: Record<FeatureId, Mode> = {
    "agents.skills": "writable",
    "observability.llm": "writable",
    "observability.xview": "writable",
  };
  const sessions = new Map<string, { refresh: string; user: User }>();
  let raw = true,
    loginCount = 0,
    logoutCount = 0,
    skillState = { ...initialSkill },
    noteState = { ...initialNote };
  let fitnessRows: {
    id: string;
    skill_name: string;
    kind: string;
    ref_id: string;
    passed: boolean;
    score: number;
    note: string;
    created_by: string;
    created_at: string;
  }[] = [];
  let writeStatus = 200;
  let savedViews = [
    {
      id: viewId,
      name: "공개 저장 뷰",
      view: "xview",
      params: "models=fixture-model",
      created_by: "합성 운영자",
      created_at: timestamp,
    },
  ];
  const writesGate = gate();
  const operations: Operation[] = [],
    unexpected: string[] = [];
  const point = {
    request_id: requestId,
    trace_id: "readonly-trace",
    created_at: timestamp,
    ingested_at: timestamp,
    latency_ms: 900,
    first_chunk_ms: 200,
    status_code: 200,
    provider: "fixture-provider",
    model: "fixture-model",
    endpoint: "/v1/chat/completions",
    total_tokens: 100,
    cost_krw: 1,
    stream: true,
  };
  const reads: Record<string, () => unknown> = {
    "GET /admin/skills": () => ({ skills: [skillState] }),
    "GET /admin/skills/stats": () => ({ stats: [] }),
    "GET /admin/skills/fitness": () => ({
      skill: skillName,
      evidence: fitnessRows,
      passing_count: fitnessRows.filter((row) => row.passed).length,
      required: 2,
    }),
    "GET /admin/skills/runs": () => ({ runs: [] }),
    "GET /admin/skills/promotions": () => ({ promotions: [] }),
    "GET /admin/skills/scan": () => ({ scans: [] }),
    "GET /admin/skills/export": () => ({ version: "1", skills: [skillState] }),
    "GET /admin/skill-studio/candidates": () => ({
      candidates: [
        {
          id: "fixture-candidate",
          title: "공개 후보",
          suggested_name: "fixture-adopted",
          source: "fixture",
          suggested: { instructions: "공개 후보 지침", risk_level: "low" },
        },
      ],
    }),
    "GET /admin/skill-studio/readiness": () => ({
      name: skillName,
      status: "draft",
      next_status: "staging",
      checks: [],
      production_ready: false,
    }),
    "GET /admin/llm/timeseries": () => ({ window: "24h", bucket: "hour", since: timestamp, points: [] }),
    "GET /admin/llm/evaluations": () => ({
      summary: [],
      evaluations: [
        {
          id: "readonly-eval",
          request_id: requestId,
          trace_id: "readonly-trace",
          name: "합성 평가",
          score: 0,
          label: "확인",
          passed: false,
          created_at: timestamp,
        },
      ],
    }),
    "GET /admin/llm/feedback": () => ({ feedback: [] }),
    "GET /admin/llm/prompts": () => ({ prompts: [] }),
    "GET /admin/llm/insights": () => ({ insights: [] }),
    "GET /admin/scatter": () => ({
      points: [point],
      groups: [],
      truncated: false,
      since: timestamp,
      cursor: { ingested_at: timestamp, request_id: requestId },
      server_time: timestamp,
    }),
    "GET /admin/xview/delta": () => ({
      points: [],
      cursor: { ingested_at: timestamp, request_id: requestId },
      has_more: false,
      server_time: timestamp,
    }),
    "GET /admin/saved-filters": () => ({ filters: savedViews }),
    [`GET /admin/llm/traces/${requestId}`]: () => ({
      request: { id: requestId, model: "fixture-model", status_code: 200, created_at: timestamp },
      spans: [],
      tools: [],
      evaluations: [],
      feedback: [],
    }),
    [`GET /admin/requests/${requestId}/note`]: () => noteState,
    ...Object.fromEntries(
      ["explain", "trace", "links"].map((suffix) => [
        `GET /admin/requests/${requestId}/${suffix}`,
        () => ({ request_id: requestId, spans: [], counts: {} }),
      ]),
    ),
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "",
      session = sessions.get(authorization);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-readonly-fixture" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email),
        access = `public-readonly-access-${++loginCount}`,
        refresh = `public-readonly-refresh-${loginCount}`;
      sessions.set(`Bearer ${access}`, { refresh, user });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user, modes, raw));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.18",
        auth_enabled: true,
        credential_prefixes: ["public-fixture-key-"],
        ...(session ? { user: session.user } : {}),
      });
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/") && !path.startsWith("/me/"))
      return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Fixture session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      sessions.delete(authorization);
      logoutCount += 1;
      return json({ ok: true });
    }
    if (Object.hasOwn(reads, call)) {
      operations.push({ call, kind: "read", body: null, userId: session.user.id });
      return json(reads[call]?.());
    }
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    if (
      call === "POST /admin/skills/evaluate" ||
      (call === "POST /admin/skills/recommend" && url.searchParams.get("apply") !== "1")
    ) {
      operations.push(structuredClone({ call, kind: "compute", body, userId: session.user.id }));
      return call.endsWith("evaluate")
        ? json({ name: skillName, allowed: true, violations: [], enforcement: "observe", would_block: false })
        : json({
            recommendations: [{ name: "fixture-recommended", description: "순수 추천 계산 결과", count: 1 }],
            applied: false,
          });
    }
    const allowedWrites = [
      "POST /admin/skills",
      "POST /admin/skills/promote",
      "POST /admin/skills/import",
      "POST /admin/skills/seed-recommended",
      "POST /admin/skills/recommend",
      "POST /admin/skill-studio/adopt",
      "POST /admin/skills/fitness",
      `DELETE /admin/skills/by-name/${skillName}`,
      `PATCH /admin/requests/${requestId}/note`,
      `DELETE /admin/requests/${requestId}/note`,
      "POST /admin/llm/feedback",
      "POST /admin/saved-filters",
      `PATCH /admin/saved-filters/${viewId}`,
      `DELETE /admin/saved-filters/${viewId}`,
    ];
    const execute = [
      `POST /admin/requests/${requestId}/analyze`,
      `POST /admin/requests/${requestId}/replay`,
    ].includes(call);
    if (execute || allowedWrites.includes(call)) {
      operations.push(
        structuredClone({ call, kind: execute ? "execute" : "write", body, userId: session.user.id }),
      );
      const status = writeStatus;
      await writesGate.wait();
      if (status !== 200) return json({ error: { message: "Synthetic write failed" } }, status);
      if (call === "POST /admin/skills/fitness") {
        const row = {
          id: `fixture-evidence-${fitnessRows.length + 1}`,
          skill_name: String(body?.skill),
          kind: String(body?.kind),
          ref_id: String(body?.ref_id),
          passed: body?.passed === true,
          score: Number(body?.score),
          note: String(body?.note ?? ""),
          created_by: session.user.id,
          created_at: "",
        };
        fitnessRows = [...fitnessRows, { ...row, created_at: timestamp }];
        return json(row, 201);
      }
      if (call === `PATCH /admin/requests/${requestId}/note`) {
        const preserve = body?.preserve_fields as string[];
        noteState = {
          ...noteState,
          exists: true,
          note: preserve.includes("note") ? noteState.note : String(body?.note ?? ""),
          tags: preserve.includes("tags") ? noteState.tags : (body?.tags as string[]),
        };
        return json(noteState);
      }
      if (call === `DELETE /admin/requests/${requestId}/note`) {
        noteState = { ...noteState, note: "", tags: [], exists: false };
        return json({ id: requestId, status: "deleted" });
      }
      if (call === "POST /admin/skills") {
        skillState = { ...skillState, ...body };
        return json({ skill: skillState });
      }
      if (call === "POST /admin/skills/import") return json({ imported_count: 1, skipped: [] });
      if (call === "POST /admin/skills/seed-recommended") return json({ seeded: ["fixture-seeded"] });
      if (call === "POST /admin/skills/recommend")
        return json({ recommendations: [], applied: true, count: 1 });
      if (call === "POST /admin/llm/feedback")
        return json({ feedback: { id: "fixture-feedback", ...body, created_at: timestamp } }, 201);
      if (call === "POST /admin/saved-filters") {
        const filter = {
          id: "fixture-created-view",
          name: String(body?.name),
          params: String(body?.params),
          view: "xview",
          created_by: session.user.id,
          created_at: timestamp,
        };
        savedViews = [...savedViews, filter];
        return json({ filter }, 201);
      }
      if (call === `PATCH /admin/saved-filters/${viewId}`) {
        savedViews = savedViews.map((view) =>
          view.id === viewId ? { ...view, params: String(body?.params) } : view,
        );
        return json({ filter: savedViews[0] });
      }
      if (call === `DELETE /admin/saved-filters/${viewId}`) {
        savedViews = savedViews.filter((view) => view.id !== viewId);
        return json({ id: viewId, status: "deleted" });
      }
      if (call.endsWith("analyze")) return json({ request_id: requestId, analysis: "합성 분석 결과" });
      if (call.endsWith("replay")) return json({ result: "합성 외부 실행 응답" });
      return json({ ok: true, skill: skillState });
    }
    unexpected.push(call);
    return json({ error: { message: "Unexpected readonly fixture request" } }, 501);
  });
  return {
    operations,
    unexpected,
    mutations: () => operations.filter((entry) => entry.kind === "write" || entry.kind === "execute"),
    count: (call: string) => operations.filter((entry) => entry.call === call).length,
    setMode: (feature: FeatureId, mode: Mode) => {
      modes[feature] = mode;
    },
    setRaw: (value: boolean) => {
      raw = value;
    },
    setWritable: (value: boolean) => {
      for (const session of sessions.values())
        session.user.scopes = ["admin:read", ...(value ? ["admin:write"] : [])];
    },
    holdWrites: writesGate.hold,
    releaseWrites: writesGate.release,
    failWrites: () => {
      writeStatus = 500;
    },
    succeedWrites: () => {
      writeStatus = 200;
    },
    logouts: () => logoutCount,
  };
}
type Gateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseWrites();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
