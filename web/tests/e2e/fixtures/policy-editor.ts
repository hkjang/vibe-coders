import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../../src/shared/api/generated";
import type { Policy } from "../../../src/shared/api/domains/governance";

export const account = {
  id: "public-policy-editor",
  email: "policy-editor@example.invalid",
  name: "공개 정책 편집자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-policy-team",
  scopes: ["admin:read", "admin:write", "security:read"],
};
export const policy: Policy = {
  id: "public-edit-policy",
  name: "공개 편집 정책",
  description: "두 규칙의 보존을 확인합니다.",
  enabled: false,
  priority: 100,
  rollout_percent: 25,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  rules: [
    {
      id: "public-rule-one",
      policy_id: "public-edit-policy",
      name: "첫 번째 규칙",
      enabled: true,
      priority: 10,
      conditions: { model: "public-model", future_filter: { MixedCase: ["keep", 7, null] } },
      actions: { block: true },
    },
    {
      id: "public-rule-two",
      policy_id: "public-edit-policy",
      name: "보존할 규칙",
      enabled: false,
      priority: 20,
      conditions: { team: "public-team" },
      actions: { require_approval: true, future_action: ["keep"] },
    },
  ],
};
type Reply = { status?: number; body: unknown; requestId?: string; commit?: boolean };
type Hold = { promise: Promise<void>; release: () => void };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function installGateway(context: BrowserContext, origin: string) {
  let user = structuredClone(account);
  let readOnly = false;
  let status: "preview" | "preview_read_only" = "preview";
  let prefixes = ["corp_"];
  let rows: unknown[] = [structuredClone(policy)];
  let reads = 0;
  const saves: Record<string, unknown>[] = [];
  const finished: number[] = [];
  const unexpected: string[] = [];
  const otherWrites: string[] = [];
  const sessions = new Set<string>();
  const holds = new Map<string, Hold>();
  const replies = new Map<number, Reply>();
  const failedReads = new Set<number>();
  let failReadsAfterSave = false;
  function hold(kind: "read" | "save", sequence: number) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(`${kind}:${sequence}`, { promise, release });
  }
  function bootstrap(authenticated: boolean): UiBootstrapResponse {
    return {
      backend_version: "v0.86.31",
      ui_version: "synthetic-policy-editor",
      api_version: "v1",
      ui: {
        enabled: true,
        default_entry: "/app/governance/policies",
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
    // Count before authentication. The transport does not enforce readonly,
    // current revision, active/disabled state or duplicate guards for the UI.
    let save = 0;
    if (call === "POST /admin/policies") {
      const body: unknown = request.postDataJSON();
      if (!object(body)) throw new Error("Expected object policy body");
      saves.push(body);
      save = saves.length;
    } else if (url.pathname.startsWith("/admin/") && request.method() !== "GET") otherWrites.push(call);
    const json = (body: unknown, responseStatus = 200, requestId = "req-public-policy-editor") =>
      route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: account.email, password: "public-password" });
      sessions.add("Bearer public-editor-access");
      return json({
        access_token: "public-editor-access",
        refresh_token: "public-editor-refresh",
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
      if (save) {
        expect(url.search).toBe("");
        expect(request.headers()["x-vibe-route"]).toBe("governance.policies");
        const body = saves[save - 1];
        if (!body) throw new Error("Missing recorded body");
        await holds.get(`save:${save}`)?.promise;
        const decodedAt = `2026-02-01T00:00:${String(save).padStart(2, "0")}Z`;
        const { rules: submittedRules, ...submittedPolicy } = structuredClone(body);
        const decodedRules = Array.isArray(submittedRules)
          ? submittedRules.map((rule: unknown, index: number) => {
              if (!object(rule)) throw new Error("Expected rule object");
              return {
                ...structuredClone(rule),
                id: rule.id ?? `public-new-rule-${save}-${index}`,
                policy_id: body.id,
                created_at: decodedAt,
                updated_at: "0001-01-01T00:00:00Z",
              };
            })
          : [];
        const decoded = {
          ...submittedPolicy,
          created_at: decodedAt,
          updated_at: "0001-01-01T00:00:00Z",
          // store.Policy.Rules is omitempty on both ACK and list responses.
          ...(decodedRules.length ? { rules: decodedRules } : {}),
        };
        // The actual endpoint ACK is its decoded submission, not a storage
        // reload. Keep its metadata distinct from the subsequent list result.
        const previous = rows.find((row) => object(row) && row.id === body.id);
        const updated = {
          ...decoded,
          created_at: object(previous) ? previous.created_at : decodedAt,
          updated_at: decodedAt,
        };
        const reply = replies.get(save) ?? { status: 201, body: { policy: decoded }, commit: true };
        if (reply.commit ?? ((reply.status ?? 201) >= 200 && (reply.status ?? 201) < 300)) {
          rows = rows.some((row) => object(row) && row.id === body.id)
            ? rows.map((row) => (object(row) && row.id === body.id ? updated : row))
            : [...rows, updated];
        }
        await json(reply.body, reply.status ?? 201, reply.requestId);
        finished.push(save);
        return;
      }
      if (call === "GET /admin/policies") {
        reads += 1;
        const sequence = reads;
        const result = structuredClone(rows);
        const failed = failedReads.has(sequence) || (failReadsAfterSave && saves.length > 0);
        await holds.get(`read:${sequence}`)?.promise;
        return failed
          ? json({ error: { message: "public policy read unavailable" } }, 503)
          : json({ policies: result });
      }
      const empty: Record<string, unknown> = {
        "GET /admin/kill-switch": { disabled: false },
        "GET /admin/incidents": { incidents: [] },
        "GET /admin/policies/regression/cases": { cases: [] },
        "GET /admin/policies/decisions": { policy_decisions: [] },
        "GET /admin/approvals": { approvals: [] },
        "GET /admin/security/secrets": { secret_events: [] },
        "GET /admin/alerts": { rules: [] },
        "GET /admin/cost": { enabled: false, threshold_krw: 1000 },
      };
      if (call in empty) return json(empty[call]);
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    if (url.pathname.startsWith("/app/") || url.pathname === "/favicon.ico") return route.continue();
    unexpected.push(call);
    return route.abort("blockedbyclient");
  });
  return {
    saves,
    finished,
    unexpected,
    otherWrites,
    reads: () => reads,
    policies: (next: unknown[]) => {
      rows = structuredClone(next);
    },
    reply: (sequence: number, next: Reply) => replies.set(sequence, next),
    failRead: (sequence: number) => failedReads.add(sequence),
    failFollowupReads: (failed: boolean) => {
      failReadsAfterSave = failed;
    },
    writable: (allowed: boolean) => {
      user = { ...user, scopes: account.scopes.filter((scope) => allowed || scope !== "admin:write") };
    },
    readable: (allowed: boolean) => {
      user = { ...user, scopes: account.scopes.filter((scope) => allowed || scope !== "security:read") };
    },
    readonly: (mode: "flag" | "status" | false) => {
      readOnly = mode === "flag";
      status = mode === "status" ? "preview_read_only" : "preview";
    },
    owner: (id: string) => {
      user = { ...user, id, name: "다른 공개 정책 편집자" };
    },
    prefixes: (next: string[]) => {
      prefixes = [...next];
    },
    holdRead: (sequence: number) => hold("read", sequence),
    holdSave: (sequence: number) => hold("save", sequence),
    releaseRead: (sequence: number) => holds.get(`read:${sequence}`)?.release(),
    releaseSave: (sequence: number) => holds.get(`save:${sequence}`)?.release(),
    releaseAll: () => {
      for (const item of holds.values()) item.release();
    },
  };
}
export type PolicyEditorGateway = Awaited<ReturnType<typeof installGateway>>;
export const test = base.extend<{ gateway: PolicyEditorGateway }>({
  gateway: async ({ context, baseURL }, run) => {
    if (!baseURL) throw new Error("Expected local synthetic UI base URL");
    const gateway = await installGateway(context, new URL(baseURL).origin);
    try {
      await run(gateway);
    } finally {
      gateway.releaseAll();
      await context.unrouteAll({ behavior: "wait" });
      expect(gateway.unexpected).toEqual([]);
      expect(gateway.otherWrites).toEqual([]);
    }
  },
});
