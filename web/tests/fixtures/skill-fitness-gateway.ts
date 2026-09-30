import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic responses only: Go authorization, persistence, audit and promotion
// rules are covered separately by real HTTP/database contracts, not this fixture.
export const targetUrl = "/app/agents/skills";
export const firstEmail = "fitness-one@example.invalid";
export const secondEmail = "fitness-two@example.invalid";
export const readerEmail = "fitness-reader@example.invalid";
export const firstName = "분석 스킬";
export const secondName = "검토 스킬";
const timestamp = "2026-09-30T01:00:00Z";
export const evidence = {
  id: "fixture-evidence-one",
  skill_name: firstName,
  kind: "multimodel",
  ref_id: "public-run-one",
  passed: true,
  score: 0,
  note: "합성 평가 근거",
  created_by: "합성 검토자",
  created_at: timestamp,
};
export const initial = { skill: firstName, evidence: [evidence], passing_count: 1, required: 2 };
export const skill = (name: string) => ({
  name,
  version: "1.0.0",
  status: "draft",
  risk_level: "high",
  owner: "합성 운영자",
  description: "브라우저 전용 스킬",
  instructions: "공개 테스트 지침",
  allowed_models: "fixture-model",
  allowed_tools: "",
  allowed_teams: "",
  daily_limit: 100,
  updated_at: timestamp,
});
type Fitness = typeof initial;
type Body = { skill: string; kind: string; ref_id: string; passed: boolean; score: number; note: string };
const userFor = (email: string) => ({
  id: email === secondEmail ? "fitness-two" : email === readerEmail ? "fitness-reader" : "fitness-one",
  email,
  name: "스킬 근거 검토자",
  role: email === readerEmail ? "readonly_admin" : "fitness_operator",
  roles: [email === readerEmail ? "readonly_admin" : "fitness_operator"],
  scopes: ["admin:read", ...(email === readerEmail ? [] : ["admin:write"])],
  team_id: "fitness-fixture-team",
  features: { "agents.skills": true, "system.health": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(user: User | undefined): UiBootstrapResponse {
  return {
    backend_version: "v0.86.17",
    ui_version: "skill-fitness-fixture",
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
      authenticated: Boolean(user),
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    ...(user ? { user } : {}),
    roles: user?.roles ?? [],
    permissions: user?.scopes ?? [],
    allowed_features: user ? ["agents.skills", "system.health"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      { feature_id: "agents.skills", title: "스킬", app_path: targetUrl, legacy_path: "/admin#/skills" },
      {
        feature_id: "system.health",
        title: "시스템 상태",
        app_path: "/app/system/health",
        legacy_path: "/admin#/health",
      },
    ].map((feature) => ({
      ...feature,
      status: feature.feature_id === "system.health" ? "legacy" : "preview",
      risk_level: "medium",
      read_only: false,
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      required_permission: "admin:read",
      minimum_api_version: "v0.84.0",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { [targetUrl]: "/admin#/skills" },
  };
}
function gate() {
  let pending: Promise<void> | undefined, release: (() => void) | undefined;
  return {
    hold: () => {
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
      pending = undefined;
    },
    wait: () => pending,
  };
}
async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, { refresh: string; user: User }>();
  const fitness = new Map<string, unknown>([
    [firstName, structuredClone(initial)],
    [secondName, { skill: secondName, evidence: [], passing_count: 0, required: 2 }],
  ]);
  let skills = [skill(firstName), skill(secondName)];
  let readStatus = 200,
    writeStatus = 201,
    readCount = 0,
    logins = 0,
    logouts = 0,
    logoutResponses = 0;
  let failAfterSave = false;
  let responseOverride: unknown,
    overrideResponse = false;
  const readGate = gate(),
    writeGate = gate(),
    logoutGate = gate();
  const writes: { method: string; body: Body; userId: string }[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "",
      session = sessions.get(authorization);
    const json = (body: unknown, status = 200, requestId = "req-fitness-fixture") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail, readerEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email),
        access = `public-fitness-access-${++logins}`,
        refresh = `public-fitness-refresh-${logins}`;
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
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({
        version: "v0.86.17",
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
      return json({ error: { message: "Fixture login required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      expect(request.postDataJSON()).toEqual({ refresh_token: session.refresh });
      sessions.delete(authorization);
      logouts += 1;
      await logoutGate.wait();
      await json({ ok: true });
      logoutResponses += 1;
      return;
    }
    if (call === "GET /admin/skills") return json({ skills });
    if (call === "GET /admin/skills/stats") return json({ stats: [] });
    if (call === "GET /admin/skills/runs") return json({ runs: [] });
    if (call === "GET /admin/skills/promotions") return json({ promotions: [] });
    if (call === "GET /admin/skills/fitness") {
      expect(request.headers()["x-vibe-ui"]).toBe("app");
      const name = url.searchParams.get("skill") ?? "";
      expect(fitness.has(name)).toBe(true);
      readCount += 1;
      const snapshot = structuredClone(fitness.get(name)),
        status = readStatus;
      await readGate.wait();
      return status === 200
        ? json(snapshot, 200, "req-fitness-read")
        : json({ error: { message: "Synthetic fitness read failed" } }, status, "req-fitness-read");
    }
    if (call === "POST /admin/skills/fitness") {
      const body = request.postDataJSON() as Body;
      expect(Object.keys(body).sort()).toEqual(["kind", "note", "passed", "ref_id", "score", "skill"]);
      expect(["multimodel", "golden", "testcase"]).toContain(body.kind);
      expect(Number.isFinite(body.score)).toBe(true);
      expect(typeof body.passed).toBe("boolean");
      writes.push(structuredClone({ method: request.method(), body, userId: session.user.id }));
      const status = writeStatus,
        writable = session.user.scopes.includes("admin:write");
      await writeGate.wait();
      if (!writable) return json({ error: { message: "Synthetic read-only session" } }, 401);
      if (status !== 201)
        return json({ error: { message: "Synthetic fitness save failed" } }, status, "req-fitness-write");
      const row = {
        id: `fixture-record-${writes.length}`,
        skill_name: body.skill,
        kind: body.kind,
        ref_id: body.ref_id,
        passed: body.passed,
        score: body.score,
        note: body.note,
        created_by: session.user.id,
        created_at: "",
      };
      const current = fitness.get(body.skill) as Fitness;
      const rows = [...current.evidence, { ...row, created_at: timestamp }];
      fitness.set(body.skill, {
        ...current,
        evidence: rows,
        passing_count: rows.filter((entry) => entry.passed).length,
      });
      if (failAfterSave) readStatus = 503;
      // Legacy 201 legitimately omits the persisted time; later GET supplies it.
      return json(overrideResponse ? responseOverride : row, 201, "req-fitness-write");
    }
    unexpected.push(call);
    return json({ error: { message: "Unexpected skill fitness fixture request" } }, 501);
  });
  return {
    writes,
    unexpected,
    reads: () => readCount,
    logouts: () => logouts,
    logoutResponses: () => logoutResponses,
    replaceFitness: (next: unknown, name = firstName) => {
      fitness.set(name, structuredClone(next));
    },
    replaceSkills: (next: typeof skills) => {
      skills = structuredClone(next);
    },
    setWritable: (value: boolean) => {
      for (const session of sessions.values())
        session.user.scopes = ["admin:read", ...(value ? ["admin:write"] : [])];
    },
    failReads: () => {
      readStatus = 503;
    },
    succeedReads: () => {
      readStatus = 200;
    },
    failWrites: (status = 500) => {
      writeStatus = status;
    },
    succeedWrites: () => {
      writeStatus = 201;
    },
    overrideWriteResponse: (next: unknown) => {
      overrideResponse = true;
      responseOverride = next;
    },
    failReadAfterSave: () => {
      failAfterSave = true;
    },
    holdReads: readGate.hold,
    releaseReads: readGate.release,
    holdWrites: writeGate.hold,
    releaseWrites: writeGate.release,
    holdLogouts: logoutGate.hold,
    releaseLogouts: logoutGate.release,
  };
}
type Gateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.releaseReads();
      gateway.releaseWrites();
      gateway.releaseLogouts();
      expect(gateway.unexpected).toEqual([]);
    }
  },
});
