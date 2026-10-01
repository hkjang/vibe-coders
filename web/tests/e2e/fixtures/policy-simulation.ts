import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { PolicySimulation, PolicySuggestion } from "../../../src/shared/api/domains/governance";

export const account = {
  id: "public-policy-reviewer",
  email: "policy@example.invalid",
  name: "정책 검토 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-policy-team",
  scopes: ["admin:read", "admin:write", "security:read"],
};
export const suggestion: PolicySuggestion = {
  id: "public-policy-suggestion",
  title: "공개 위험 점수 차단 추천",
  rationale: "합성 요청의 위험 점수를 검토합니다.",
  severity: "warning",
  conditions: { risk_score: ">=70" },
  actions: { block: true },
};
export const success: PolicySimulation = {
  evaluated: 12,
  blocked: 3,
  require_approval: 0,
  allowed: 9,
  block_rate: 0.25,
  since: "2026-09-24T01:00:00Z",
  shadow: {
    affected_keys: 2,
    affected_teams: 1,
    false_positive_candidates: 2,
    false_positive_rate: 2 / 3,
    blocked_cost_krw: 150,
    false_positive_sample: [{ api_key_id: "public-sample-key-must-not-render" }],
  },
};
type Reply = { status?: number; body: unknown };
type Hold = { promise: Promise<void>; release: () => void };

async function installGateway(context: BrowserContext, origin: string) {
  let currentAccount = structuredClone(account);
  let readOnly = false;
  let status: "preview" | "preview_read_only" = "preview";
  let rows = [structuredClone(suggestion)];
  const sessions = new Set<string>();
  const unexpected: string[] = [];
  const simulations: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const finished: number[] = [];
  const replies = new Map<number, Reply>();
  const holds = new Map<number, Hold>();
  let refreshes = 0;
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.29",
      ui_version: "synthetic-policy-simulation",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/governance/policies?tab=advisor",
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
        credential_prefixes: ["corp_"],
      },
      ...(authenticated ? { user: currentAccount } : {}),
      roles: authenticated ? currentAccount.roles : [],
      permissions: authenticated ? currentAccount.scopes : [],
      capabilities: { raw_prompt_view: false },
      allowed_features: authenticated ? ["governance.policies"] : [],
      migration_registry: [
        {
          feature_id: "governance.policies",
          title: "정책 및 거버넌스",
          app_path: "/app/governance/policies",
          legacy_path: "/admin#/safety",
          status,
          risk_level: "high",
          required_permission: "security:read",
          read_only: readOnly,
          enabled_roles: ["admin"],
          rollout_percent: 100,
          fallback_enabled: true,
          minimum_api_version: "v0.84.0",
          available: authenticated,
        },
      ],
      system_status: { status: "healthy" },
      legacy_route_map: { "/app/governance/policies": "/admin#/safety" },
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
    // Observe every attempt before fixture authorization; this transport does
    // not enforce UI permissions, single-flight, revision or readonly fences.
    let simulation = 0;
    if (call === "POST /admin/policies/simulate") {
      simulations.push(request.postDataJSON() as Record<string, unknown>);
      simulation = simulations.length;
    } else if (url.pathname.startsWith("/admin/") && request.method() !== "GET") {
      writes.push(call);
    }
    if (call === "POST /auth/refresh") refreshes += 1;
    const json = (body: unknown, responseStatus = 200) =>
      route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-public-policy-simulation", "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: account.email, password: "public-password" });
      sessions.add("Bearer public-policy-access");
      return json({
        access_token: "public-policy-access",
        refresh_token: "public-policy-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user: currentAccount,
      });
    }
    const authenticated = sessions.has(request.headers().authorization ?? "");
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthenticated ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (simulation) {
        expect(url.search).toBe("");
        expect(request.headers()["x-vibe-route"]).toBe("governance.policies");
        await holds.get(simulation)?.promise;
        const reply = replies.get(simulation) ?? { body: success };
        await json(reply.body, reply.status ?? 200);
        finished.push(simulation);
        return;
      }
      if (call === "GET /admin/policy-advisor/suggestions")
        return json({ window: url.searchParams.get("window"), suggestions: rows });
      if (call === "GET /admin/policies/canary-status") return json({ policies: [] });
      if (call === "GET /admin/policies") return json({ policies: [] });
      if (call === "GET /admin/model-deprecations") return json({ deprecations: [] });
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
    unexpected.push(call);
    return route.abort("blockedbyclient");
  });
  return {
    simulations,
    writes,
    finished,
    unexpected,
    refreshes: () => refreshes,
    reply: (sequence: number, reply: Reply) => replies.set(sequence, reply),
    suggestions: (next: PolicySuggestion[]) => {
      rows = structuredClone(next);
    },
    owner: (id: string) => {
      currentAccount = { ...currentAccount, id, name: "다른 공개 정책 운영자" };
    },
    writable: (allowed: boolean) => {
      currentAccount = {
        ...currentAccount,
        scopes: account.scopes.filter((scope) => allowed || scope !== "admin:write"),
      };
    },
    readonly: (mode: "flag" | "status" | false) => {
      readOnly = mode === "flag";
      status = mode === "status" ? "preview_read_only" : "preview";
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
      for (const hold of holds.values()) hold.release();
    },
  };
}

export type SimulationGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: SimulationGateway }>({
  gateway: async ({ context, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected the local synthetic UI base URL");
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
