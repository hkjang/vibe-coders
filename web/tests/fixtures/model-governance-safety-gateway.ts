import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { ModelContract, ModelDeprecation } from "../../src/shared/api/domains/model-governance.schemas";

// Synthetic browser evidence only. This fixture records attempted writes before
// responding and deliberately does not enforce the UI's runtime readonly state.
// It does not execute a model, prove Go authorization, or undo an admitted write.
export const modelsUrl = "/app/gateway/models";
export const providersUrl = "/app/gateway/providers";
export const firstEmail = "model-one@example.invalid";
export const secondEmail = "model-two@example.invalid";
export const contractId = "mcon_public_계약";
export const contractName = "공개 코드 검토 기준";
export const modelGlob = "public-legacy-*";
// Match only this public synthetic fixture's stored ID convention. Real Go
// normalization/upsert is verified separately by the HTTP/store contract lane.
const trimGoSpace = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const canonicalDeprecationId = async (glob: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(trimGoSpace(glob).toLowerCase()),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `moddep_${hex.slice(0, 20)}`;
};
export const deprecationId = "moddep_e01ba9e511b0d690b3c7";
export const createdActor = "admin_public_fixture_actor";
export const readonlyReason = "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";
export const timestamp = "2026-09-30T01:00:00Z";
export type Mode = "writable" | "read_only" | "preview_read_only";
export type Kind = "contracts" | "deprecations";
export const paths = {
  contracts: "/admin/models/contracts",
  deprecations: "/admin/model-deprecations",
} as const;
export const contractFixture = (): ModelContract => ({
  id: contractId,
  name: contractName,
  task_type: "code_review",
  min_quality_score: 70,
  min_golden_pass_rate: 0.8,
  min_success_rate: 0.95,
  max_latency_ms: 4000,
  max_avg_cost_krw: 12,
  enabled: true,
  created_by: createdActor,
  created_at: timestamp,
  updated_at: timestamp,
});
export const deprecationFixture = (): ModelDeprecation => ({
  id: deprecationId,
  model_glob: modelGlob,
  replacement: "public-replacement-model",
  sunset_date: "2027-01-31",
  message: "공개 지원 종료 안내",
  created_at: timestamp,
  updated_at: timestamp,
});
const userFor = (email: string, writable: boolean) => ({
  id: email === secondEmail ? "model-two" : "model-one",
  email,
  name: "합성 모델 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "fixture-team",
  scopes: ["admin:read", ...(writable ? ["admin:write"] : [])],
  features: { "gateway.models": true, "gateway.providers": true },
});
type User = ReturnType<typeof userFor>;
type Operation = { call: string; body: Record<string, unknown> | null; id: string | null; userId: string };

function bootstrap(user: User | undefined, mode: Mode): UiBootstrapResponse {
  return {
    backend_version: "v0.86.20",
    ui_version: "model-governance-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: modelsUrl,
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
    allowed_features: user ? ["gateway.models", "gateway.providers"] : [],
    capabilities: { raw_prompt_view: false },
    migration_registry: [
      {
        feature_id: "gateway.models",
        title: "모델",
        app_path: modelsUrl,
        legacy_path: "/admin#/models",
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
    legacy_route_map: { [modelsUrl]: "/admin#/models", [providersUrl]: "/admin#/settings" },
  };
}

async function install(context: BrowserContext) {
  expect(await canonicalDeprecationId(modelGlob)).toBe(deprecationId);
  let mode: Mode = "writable",
    writable = true,
    logins = 0,
    sequence = 0,
    writeStatus = 200,
    runStatus = 200;
  let contracts = [contractFixture()],
    deprecations = [deprecationFixture()];
  const sessions = new Map<string, { user: User; refresh: string }>();
  const writes: Operation[] = [],
    runs: Operation[] = [],
    reads: string[] = [],
    unexpected: string[] = [];
  const readStatus: Record<Kind, number> = { contracts: 200, deprecations: 200 };
  const readPayload = new Map<Kind, unknown>();
  const gates = new Map<string, Promise<void>>(),
    releases = new Map<string, () => void>();
  const release = (key: string) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  const snapshot = <T>(value: T): T => structuredClone(value);
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method(),
      call = `${method} ${path}`;
    const authorization = request.headers().authorization ?? "",
      session = sessions.get(authorization);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-model-governance" },
        body: JSON.stringify(body),
      });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external-origin ${call}`);
      return json({ error: { message: "Model governance fixture forbids external requests" } }, 501);
    }
    if (call === "POST /auth/login") {
      const body = request.postDataJSON() as { email: string; password: string };
      expect([firstEmail, secondEmail]).toContain(body.email);
      expect(body.password).toBe("public-test-password");
      const user = userFor(body.email, writable),
        access = `public-model-access-${++logins}`,
        refresh = `public-model-refresh-${logins}`;
      sessions.set(`Bearer ${access}`, { user, refresh });
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(session?.user, mode));
    if (call === "GET /auth/sso/status")
      return json({ keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" });
    if (call === "GET /auth/me")
      return json({ version: "v0.86.20", auth_enabled: true, ...(session ? { user: session.user } : {}) });
    if (call === "GET /health" || call === "GET /ready")
      return json({ status: path === "/health" ? "ok" : "ready" });
    if (path.startsWith("/v1/") || path.startsWith("/mcp")) {
      unexpected.push(`external-or-runtime ${call}`);
      return json({ error: { message: "Model governance fixture forbids external execution" } }, 501);
    }
    if (!path.startsWith("/admin/") && !path.startsWith("/auth/")) return route.continue();
    if (!session) {
      unexpected.push(`unauthenticated ${call}`);
      return json({ error: { message: "Synthetic session required" } }, 401);
    }
    if (call === "POST /auth/logout") {
      sessions.delete(authorization);
      return json({ status: "logged_out" });
    }
    if (method === "GET") {
      reads.push(call);
      if (path === paths.contracts || path === paths.deprecations) {
        const kind: Kind = path === paths.contracts ? "contracts" : "deprecations";
        const status = readStatus[kind],
          payload = snapshot(
            readPayload.has(kind)
              ? readPayload.get(kind)
              : { [kind]: kind === "contracts" ? contracts : deprecations },
          );
        await gates.get(`read:${kind}`);
        return json(status === 200 ? payload : { error: { message: "Synthetic list unavailable" } }, status);
      }
      if (path === "/admin/models")
        return json({
          generated_at: timestamp,
          models: [],
          partial_failures: [],
          providers: [],
          request_id: "req-model-governance",
        });
      if (path === "/admin/models/quality") return json({ categories: [], models: [], since: timestamp });
      if (path === "/admin/pricing") return json({ effective: {}, versions: [] });
      if (path === "/admin/model-tags") return json({ tags: [] });
      if (path === "/admin/providers") return json({ providers: [] });
      if (path === "/admin/providers/slo") return json({ slos: [], evaluations: [], since: timestamp });
    }
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null;
    const operation = { call, body: snapshot(body), id: url.searchParams.get("id"), userId: session.user.id };
    if (call === "POST /admin/models/contracts/run") {
      runs.push(operation);
      const status = runStatus;
      await gates.get("run");
      return json(
        status === 200
          ? {
              model: body?.model ?? "",
              window: timestamp,
              replaceable: false,
              note: "합성 관측 지표 비교이며 실제 호출이나 승격이 아닙니다.",
              have_metrics: { quality: false, latency: false, cost: false },
              results: [
                {
                  contract_id: contractId,
                  contract_name: contractName,
                  task_type: "code_review",
                  verdict: "no_data",
                  replaceable: false,
                  checks: [{ dimension: "quality_score", threshold: 70, actual: null, status: "no_data" }],
                },
              ],
              failing_samples: [],
            }
          : { error: { message: "Synthetic computation failed" } },
        status,
      );
    }
    if (
      call === `POST ${paths.contracts}` ||
      call === `DELETE ${paths.contracts}` ||
      call === `POST ${paths.deprecations}` ||
      (method === "DELETE" && path.startsWith(`${paths.deprecations}/`))
    ) {
      writes.push(operation);
      const status = writeStatus;
      await gates.get("write");
      if (status !== 200) return json({ error: { message: "Synthetic write failed" } }, status);
      if (call === `POST ${paths.contracts}`) {
        const id = (typeof body?.id === "string" ? trimGoSpace(body.id) : "") || `mcon_created_${++sequence}`;
        const existing = contracts.find((row) => row.id === id);
        const number = (key: string) => {
          const value = body?.[key];
          expect(value === undefined || value === null || typeof value === "number").toBe(true);
          return typeof value === "number" ? value : 0;
        };
        const row: ModelContract = {
          id,
          name: trimGoSpace(String(body?.name ?? "")),
          task_type: trimGoSpace(String(body?.task_type ?? "")),
          min_quality_score: number("min_quality_score"),
          min_golden_pass_rate: number("min_golden_pass_rate"),
          min_success_rate: number("min_success_rate"),
          max_latency_ms: number("max_latency_ms"),
          max_avg_cost_krw: number("max_avg_cost_krw"),
          enabled: typeof body?.enabled === "boolean" ? body.enabled : true,
          created_by: existing?.created_by ?? createdActor,
          created_at: existing?.created_at ?? timestamp,
          updated_at: timestamp,
        };
        contracts = [...contracts.filter((item) => item.id !== id), row];
        return json({ id, ok: true });
      }
      if (call === `DELETE ${paths.contracts}`) {
        contracts = contracts.filter((row) => row.id !== operation.id);
        return json({ ok: true });
      }
      if (call === `POST ${paths.deprecations}`) {
        const glob = trimGoSpace(String(body?.model_glob ?? ""));
        const id = await canonicalDeprecationId(glob);
        const existing = deprecations.find((row) => row.id === id);
        const row: ModelDeprecation = {
          id,
          model_glob: glob,
          replacement: trimGoSpace(String(body?.replacement ?? "")),
          sunset_date: trimGoSpace(String(body?.sunset_date ?? "")),
          message: trimGoSpace(String(body?.message ?? "")),
          created_at: existing?.created_at ?? timestamp,
          updated_at: timestamp,
        };
        deprecations = [...deprecations.filter((item) => item.id !== row.id), row];
        return json({ deprecation: row }, 201);
      }
      const id = decodeURIComponent(path.slice(`${paths.deprecations}/`.length));
      deprecations = deprecations.filter((row) => row.id !== id);
      return json({ id, deleted: true });
    }
    unexpected.push(call);
    return json({ error: { message: "Unexpected model governance fixture request" } }, 501);
  });
  return {
    writes,
    runs,
    reads,
    unexpected,
    setMode: (value: Mode) => {
      mode = value;
    },
    setWriteScope: (value: boolean) => {
      writable = value;
      for (const session of sessions.values())
        session.user.scopes = userFor(session.user.email, value).scopes;
    },
    setWriteStatus: (value: number) => {
      writeStatus = value;
    },
    setRunStatus: (value: number) => {
      runStatus = value;
    },
    setReadStatus: (kind: Kind, value: number) => {
      readStatus[kind] = value;
    },
    setReadPayload: (kind: Kind, value: unknown) => {
      readPayload.set(kind, value);
    },
    clearReadPayload: (kind: Kind) => {
      readPayload.delete(kind);
    },
    setContracts: (value: ModelContract[]) => {
      contracts = snapshot(value);
    },
    setDeprecations: (value: ModelDeprecation[]) => {
      deprecations = snapshot(value);
    },
    getContracts: () => snapshot(contracts),
    getDeprecations: () => snapshot(deprecations),
    hold: (key: string) => {
      gates.set(key, new Promise<void>((resolve) => releases.set(key, resolve)));
    },
    release,
    releaseAll: () => {
      for (const key of [...gates.keys()]) release(key);
    },
  };
}
type Gateway = Awaited<ReturnType<typeof install>>;
export const test = base.extend<{ gateway: Gateway }>({
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
