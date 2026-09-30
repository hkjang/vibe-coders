import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Public synthetic browser fixtures only. Real HTTP/JWT/transaction/runtime
// enforcement is covered separately by Go contracts, not by these mock routes.
export const targetUrl = "/app/governance/policies";
export const routingUrl = "/app/routing/rules/preview";
export const firstEmail = "cost-one@example.invalid";
export const secondEmail = "cost-two@example.invalid";
export const readerEmail = "cost-reader@example.invalid";
export const initial = { enabled: true, threshold_krw: 47.25 };
export type Config = typeof initial;
const userFor = (email: string) => ({
  id: email === secondEmail ? "cost-two" : email === readerEmail ? "cost-reader" : "cost-one",
  email,
  name: "비용 보호 검토자",
  role: email === readerEmail ? "readonly_admin" : "admin",
  roles: [email === readerEmail ? "readonly_admin" : "admin"],
  scopes: ["admin:read", "security:read", "routing:read", ...(email === readerEmail ? [] : ["admin:write"])],
  team_id: "cost-fixture-team",
  features: { "governance.policies": true, "routing.rules": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(
  user: User | undefined,
  version: string | undefined,
): Omit<UiBootstrapResponse, "backend_version"> & { backend_version?: string } {
  return {
    ...(version === undefined ? {} : { backend_version: version }),
    ui_version: "cost-guard-fixture",
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
    allowed_features: user ? ["governance.policies", "routing.rules"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "governance.policies",
        title: "정책 및 거버넌스",
        app_path: targetUrl,
        legacy_path: "/admin#/safety",
        required_permission: "security:read",
      },
      {
        feature_id: "routing.rules",
        title: "라우팅",
        app_path: "/app/routing/rules",
        legacy_path: "/admin#/routing",
        required_permission: "routing:read",
      },
    ].map((feature) => ({
      ...feature,
      status: "preview",
      risk_level: "high",
      read_only: false,
      enabled_roles: [],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.84.0",
      available: Boolean(user),
    })),
    system_status: { status: "healthy" },
    legacy_route_map: { [targetUrl]: "/admin#/safety", "/app/routing/rules": "/admin#/routing" },
  };
}
function gate() {
  let promise: Promise<void> | undefined;
  let release: (() => void) | undefined;
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
async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, { refresh: string; user: User }>();
  let config: unknown = { ...initial };
  let version: string | undefined = "v0.86.15";
  let readStatus = 200;
  let writeStatus = 200;
  let failAfterSave = false;
  let readCount = 0;
  let bootstrapCount = 0;
  let logins = 0;
  let logouts = 0;
  let logoutResponses = 0;
  const readGate = gate(),
    writeGate = gate(),
    logoutGate = gate();
  const writes: { body: Config; userId: string }[] = [];
  const unexpected: string[] = [];
  const otherReads: Record<string, unknown> = {
    "GET /admin/kill-switch": { disabled: false },
    "GET /admin/incidents": { incidents: [] },
    "GET /admin/policies": { policies: [] },
    "GET /admin/policies/regression/cases": { cases: [] },
    "GET /admin/policies/decisions": { policy_decisions: [] },
    "GET /admin/policies/canary-status": { policies: [] },
    "GET /admin/approvals": { approvals: [] },
    "GET /admin/security/secrets": { events: [] },
    "GET /admin/alerts": { rules: [], events: [] },
    "GET /admin/model-deprecations": { deprecations: [] },
    "GET /admin/routing-rules": { rules: [] },
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "";
    const session = sessions.get(authorization);
    const json = (body: unknown, status = 200, requestId = "req-cost-fixture") =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      const body: { email: string; password: string } = request.postDataJSON();
      expect([firstEmail, secondEmail, readerEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email);
      const access = `public-cost-access-${++logins}`,
        refresh = `public-cost-refresh-${logins}`;
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
    if (call === "GET /admin/ui-bootstrap") {
      bootstrapCount += 1;
      return json(bootstrap(session?.user, version));
    }
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    // A missing bootstrap version exercises the existing auth fallback. Its empty
    // version must remain unconfirmed; it is not a synthetic v15 capability.
    if (call === "GET /auth/me")
      return json({
        version: version ?? "",
        auth_enabled: true,
        credential_prefixes: ["public-fixture-key-"],
        ...(session ? { user: session.user } : {}),
      });
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (path.startsWith("/auth/") || path.startsWith("/admin/") || path.startsWith("/me/")) {
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
      if (call === "GET /admin/cost") {
        readCount += 1;
        const snapshot = structuredClone(config),
          status = readStatus;
        await readGate.wait();
        return status === 200
          ? json(snapshot, 200, "req-cost-read")
          : json(
              {
                error: {
                  message: "Synthetic cost configuration unavailable",
                  code: "cost_guard_config_unavailable",
                },
              },
              status,
              "req-cost-read",
            );
      }
      if (call === "POST /admin/cost") {
        const body = request.postDataJSON() as Config;
        expect(Object.keys(body).sort()).toEqual(["enabled", "threshold_krw"]);
        expect(typeof body.enabled).toBe("boolean");
        expect(Number.isFinite(body.threshold_krw) && body.threshold_krw >= 0).toBe(true);
        const snapshot = structuredClone({ body, userId: session.user.id });
        writes.push(snapshot);
        const status = writeStatus;
        const writable = session.user.scopes.includes("admin:write");
        await writeGate.wait();
        if (!writable) return json({ error: { message: "Synthetic read-only session" } }, 401);
        if (status !== 200)
          return json(
            { error: { message: "Synthetic save failed", code: "cost_guard_save_failed" } },
            status,
            "req-cost-write",
          );
        config = structuredClone(snapshot.body);
        if (failAfterSave) readStatus = 503;
        return json(snapshot.body, 200, "req-cost-write");
      }
      if (Object.hasOwn(otherReads, call)) return json(otherReads[call]);
      unexpected.push(call);
      return json({ error: { message: "Unexpected cost fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    writes,
    unexpected,
    reads: () => readCount,
    bootstraps: () => bootstrapCount,
    logouts: () => logouts,
    logoutResponses: () => logoutResponses,
    replaceConfig: (next: unknown) => {
      config = structuredClone(next);
    },
    setVersion: (next: string | undefined) => {
      version = next;
    },
    setWritable: (writable: boolean) => {
      for (const session of sessions.values())
        session.user.scopes = [
          ...session.user.scopes.filter((scope) => scope !== "admin:write"),
          ...(writable ? ["admin:write"] : []),
        ];
    },
    failReads: () => {
      readStatus = 503;
    },
    succeedReads: () => {
      readStatus = 200;
    },
    failWrites: () => {
      writeStatus = 500;
    },
    succeedWrites: () => {
      writeStatus = 200;
    },
    failReadAfterSave: (value = true) => {
      failAfterSave = value;
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
