import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Public browser fixtures only: real HTTP/JWT/store authorization is verified
// by separate Go contracts, not by this mock's response status or row changes.
export const targetUrl = "/app/agents/apps";
export const firstEmail = "app-grants-one@example.invalid";
export const secondEmail = "app-grants-two@example.invalid";
export const readerEmail = "app-grants-reader@example.invalid";
export const opaqueSubject = "팀 / QA+한글?분기=1&파트#3";
export const longSubject =
  "fixture-public-subject-with-a-very-long-unbroken-identifier-123456789012345678901234567890";
export const alpha = {
  id: "app-permission-alpha",
  title: "추가 접근 검토 앱",
  description: "공개 합성 앱입니다.",
  components: [],
  allowed_teams: "platform",
  allowed_roles: "developer",
  status: "active",
  owner: "fixture-owner",
  updated_at: "2026-09-01T00:00:00Z",
};
export const beta = { ...alpha, id: "app-permission-beta", title: "두 번째 검토 앱" };
type App = typeof alpha;
export interface Permission {
  id: string;
  app_id: string;
  subject_type?: string | null;
  subject_id?: string | null;
  granted_by: string;
  created_at: string;
}
export function permission(
  id: string,
  type: string | null | undefined,
  subject: string | null,
  appId = alpha.id,
): Permission {
  return {
    id,
    app_id: appId,
    subject_type: type,
    subject_id: subject,
    granted_by: "fixture-operator",
    created_at: "2026-09-02T00:00:00Z",
  };
}
export const existing = permission("permission-user", "user", "fixture-user-existing");
export const team = permission("permission-team", "team", opaqueSubject);
export const unknown = permission("permission-unknown", "future_subject", longSubject);

const userFor = (email: string) => ({
  id:
    email === secondEmail ? "app-grants-two" : email === readerEmail ? "app-grants-reader" : "app-grants-one",
  email,
  name: "앱 접근 권한 운영자",
  role: email === readerEmail ? "readonly_admin" : "admin",
  roles: [email === readerEmail ? "readonly_admin" : "admin"],
  scopes: email === readerEmail ? ["admin:read"] : ["admin:read", "admin:write"],
  team_id: "fixture-team",
  features: { "agents.apps": true },
});
type User = ReturnType<typeof userFor>;
function bootstrap(user?: User): UiBootstrapResponse {
  return {
    backend_version: "v0.86.13",
    ui_version: "app-permission-fixture",
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
    allowed_features: user ? ["agents.apps"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "agents.apps",
        title: "AI 업무 앱",
        app_path: targetUrl,
        legacy_path: "/admin#/apps",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: false,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: Boolean(user),
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: { [targetUrl]: "/admin#/apps" },
  };
}
type Mutation = {
  method: "POST" | "DELETE";
  appId: string;
  subject_type: string;
  subject_id: string;
  userId: string;
};

async function installGateway(context: BrowserContext) {
  const sessions = new Map<string, { refresh: string; user: User }>();
  let apps: App[] = structuredClone([alpha, beta]);
  let rows = structuredClone([
    existing,
    team,
    unknown,
    permission("permission-beta", "user", "fixture-beta-user", beta.id),
  ]);
  let listReads = 0;
  let permissionReads = 0;
  let readStatus = 200;
  let writeStatus = 200;
  let logins = 0;
  let logouts = 0;
  let logoutResponses = 0;
  let readGate: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  let writeGate: Promise<void> | undefined;
  let releaseWrite: (() => void) | undefined;
  let logoutGate: Promise<void> | undefined;
  let releaseLogout: (() => void) | undefined;
  const writes: Mutation[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const call = `${request.method()} ${path}`;
    const authorization = request.headers().authorization ?? "";
    const session = sessions.get(authorization);
    const json = (body: unknown, status = 200, requestId = "req-app-permission") =>
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
      const access = `public-app-grant-access-${++logins}`;
      const refresh = `public-app-grant-refresh-${logins}`;
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
        if (logoutGate) await logoutGate;
        await json({ ok: true });
        logoutResponses += 1;
        return;
      }
      if (call === "GET /admin/apps") {
        listReads += 1;
        return json({ apps: structuredClone(apps) });
      }
      if (call === "GET /admin/app-templates") return json({ templates: [] });
      if (call === "GET /me/app-runs") return json({ runs: [] });
      const appId = path.match(/^\/admin\/apps\/([^/]+)\/permissions$/u)?.[1];
      if (appId && request.method() === "GET") {
        permissionReads += 1;
        const snapshot = {
          app_id: appId,
          permissions: structuredClone(rows.filter((row) => row.app_id === appId)),
        };
        const status = readStatus;
        if (readGate) await readGate;
        return status === 200
          ? json(snapshot, 200, "req-app-permission-list")
          : json({ error: { message: "Permission list unavailable" } }, status, "req-app-permission-list");
      }
      if (appId && (request.method() === "POST" || request.method() === "DELETE")) {
        const method = request.method() as "POST" | "DELETE";
        const body =
          method === "POST"
            ? (request.postDataJSON() as { subject_type: string; subject_id: string })
            : {
                subject_type: url.searchParams.get("subject_type") ?? "",
                subject_id: url.searchParams.get("subject_id") ?? "",
              };
        expect(Object.keys(body).sort()).toEqual(["subject_id", "subject_type"]);
        expect(typeof body.subject_id).toBe("string");
        const snapshot = structuredClone({ method, appId, ...body, userId: session.user.id });
        writes.push(snapshot);
        const status = writeStatus;
        if (writeGate) await writeGate;
        if (!session.user.scopes.includes("admin:write"))
          return json({ error: { message: "Fixture read-only" } }, 401);
        if (status !== 200)
          return json(
            { error: { message: "App permission operation failed" } },
            status,
            "req-app-permission-write",
          );
        const same = (row: Permission) =>
          row.app_id === appId &&
          row.subject_type === snapshot.subject_type &&
          row.subject_id === snapshot.subject_id;
        if (method === "DELETE") rows = rows.filter((row) => !same(row));
        else if (!rows.some(same))
          rows.push(
            permission(
              `permission-generated-${writes.length}`,
              snapshot.subject_type,
              snapshot.subject_id,
              appId,
            ),
          );
        return json({ ok: true });
      }
      unexpected.push(call);
      return json({ error: { message: "Unexpected app permission fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    writes,
    unexpected,
    listReads: () => listReads,
    permissionReads: () => permissionReads,
    logouts: () => logouts,
    logoutResponses: () => logoutResponses,
    replaceApps: (next: App[]) => {
      apps = structuredClone(next);
    },
    replacePermissions: (next: Permission[]) => {
      rows = structuredClone(next);
    },
    failReads: () => {
      readStatus = 503;
    },
    succeedReads: () => {
      readStatus = 200;
    },
    failWrites: () => {
      writeStatus = 503;
    },
    succeedWrites: () => {
      writeStatus = 200;
    },
    holdReads: () => {
      readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseReads: () => {
      releaseRead?.();
      readGate = undefined;
    },
    holdWrites: () => {
      writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    releaseWrites: () => {
      releaseWrite?.();
      writeGate = undefined;
    },
    holdLogouts: () => {
      logoutGate = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
    },
    releaseLogouts: () => {
      releaseLogout?.();
      logoutGate = undefined;
    },
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
