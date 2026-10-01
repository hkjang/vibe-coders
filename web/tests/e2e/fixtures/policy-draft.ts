import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { PolicySuggestion } from "../../../src/shared/api/domains/governance";

export const account = {
  id: "public-draft-reviewer",
  email: "draft@example.invalid",
  name: "정책 초안 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-draft-team",
  scopes: ["admin:read", "admin:write", "security:read"],
};
export const suggestion: PolicySuggestion = {
  id: "public-draft-suggestion",
  title: "공개 위험 점수 초안 추천",
  rationale: "합성 요청의 위험 점수를 검토합니다.",
  severity: "warning",
  conditions: { risk_score: ">=70" },
  actions: { block: true },
};
type Reply = { status?: number; body: unknown; requestId?: string };
type Hold = { promise: Promise<void>; release: () => void };

async function installGateway(context: BrowserContext, origin: string) {
  let user = structuredClone(account);
  let readOnly = false;
  let status: "preview" | "preview_read_only" = "preview";
  let rows = [structuredClone(suggestion)];
  let suggestionsFail = false;
  let policyReadFail = false;
  let policyReads = 0;
  let suggestionReads = 0;
  const sessions = new Set<string>();
  const unexpected: string[] = [];
  const writes: string[] = [];
  const drafts: Record<string, unknown>[] = [];
  const finished: number[] = [];
  const replies = new Map<number, Reply>();
  const holds = new Map<number, Hold>();
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.30",
      ui_version: "synthetic-policy-draft",
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
      ...(authenticated ? { user } : {}),
      roles: authenticated ? user.roles : [],
      permissions: authenticated ? user.scopes : [],
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
    // Count attempts before auth; this transport never implements the UI's
    // readonly/scope/revision/single-flight guards on behalf of the product.
    let draft = 0;
    if (call === "POST /admin/policy-advisor/apply") {
      drafts.push(request.postDataJSON() as Record<string, unknown>);
      draft = drafts.length;
    } else if (url.pathname.startsWith("/admin/") && request.method() !== "GET") {
      writes.push(call);
    }
    const json = (body: unknown, responseStatus = 200, requestId = "req-public-policy-draft") =>
      route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: account.email, password: "public-password" });
      sessions.add("Bearer public-draft-access");
      return json({
        access_token: "public-draft-access",
        refresh_token: "public-draft-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
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
      if (draft) {
        expect(url.search).toBe("");
        expect(request.headers()["x-vibe-route"]).toBe("governance.policies");
        await holds.get(draft)?.promise;
        const reply = replies.get(draft) ?? {
          status: 201,
          body: { policy_id: `public-created-draft-${draft}`, enabled: false, note: "synthetic draft" },
        };
        await json(reply.body, reply.status ?? 201, reply.requestId);
        finished.push(draft);
        return;
      }
      if (call === "GET /admin/policy-advisor/suggestions") {
        suggestionReads += 1;
        return suggestionsFail
          ? json({ error: { message: "synthetic suggestions unavailable" } }, 503)
          : json({ window: url.searchParams.get("window"), suggestions: rows });
      }
      if (call === "GET /admin/policies") {
        policyReads += 1;
        return policyReadFail
          ? json({ error: { message: "synthetic list unavailable" } }, 503)
          : json({ policies: [] });
      }
      if (call === "GET /admin/policies/canary-status") return json({ policies: [] });
      if (call === "GET /admin/model-deprecations") return json({ deprecations: [] });
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
    unexpected.push(call);
    return route.abort("blockedbyclient");
  });
  return {
    drafts,
    writes,
    finished,
    unexpected,
    policyReads: () => policyReads,
    suggestionReads: () => suggestionReads,
    reply: (sequence: number, reply: Reply) => replies.set(sequence, reply),
    suggestions: (next: PolicySuggestion[]) => {
      rows = structuredClone(next);
    },
    failSuggestions: (value: boolean) => {
      suggestionsFail = value;
    },
    failPolicyReads: (value: boolean) => {
      policyReadFail = value;
    },
    owner: (id: string) => {
      user = { ...user, id, name: "다른 공개 초안 운영자" };
    },
    writable: (allowed: boolean) => {
      user = { ...user, scopes: account.scopes.filter((scope) => allowed || scope !== "admin:write") };
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

export type DraftGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: DraftGateway }>({
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
