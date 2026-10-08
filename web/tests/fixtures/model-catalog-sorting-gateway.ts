import { expect, test as base, type BrowserContext } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type {
  AdminModel,
  AdminModelsResponse,
  ModelQualityResponse,
  PricingResponse,
} from "../../src/shared/api/schemas";

export const alphaRef = `prv_${"a".repeat(43)}`;
export const betaRef = `prv_${"b".repeat(43)}`;
export const modelPath = "/app/gateway/models";
export const ordinaryIds = Array.from({ length: 52 }, (_, i) => `model-${String(i).padStart(2, "0")}`);
const timestamp = "2026-10-08T03:00:00Z";
const bootstrap: UiBootstrapResponse = {
  backend_version: "v0.86.45",
  ui_version: "synthetic-model-sorting",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: modelPath,
    legacy_fallback: true,
    feedback_enabled: false,
    telemetry_enabled: false,
  },
  authentication: {
    enabled: false,
    authenticated: true,
    mode: "open",
    keycloak_enabled: false,
    allow_local_login: true,
    sso_login_url: "/auth/keycloak/login",
  },
  user: {
    id: "public-model-reader",
    email: "public-model@example.invalid",
    name: "합성 모델 조회자",
    role: "admin",
    roles: ["admin"],
    team_id: "public-team",
    scopes: ["admin:read"],
    features: { "gateway.models": true },
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["gateway.models"],
  capabilities: { raw_prompt_view: false },
  migration_registry: [
    {
      feature_id: "gateway.models",
      title: "모델",
      app_path: modelPath,
      legacy_path: "/admin#/model-contracts",
      status: "preview",
      risk_level: "medium",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.84.0",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { [modelPath]: "/admin#/model-contracts" },
};

function model(id: string, overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id,
    created: 1_700_000_000,
    deprecation: null,
    fetched_at: timestamp,
    object: "model",
    owned_by: "public-owner",
    provider: "alpha",
    provider_ref: alphaRef,
    shadowed: false,
    shadowed_by: "",
    source: "live",
    stale: false,
    virtual: false,
    ...overrides,
  };
}
function fixtures() {
  const models = [
    ...ordinaryIds.map((id, index) => model(id, index === 0 ? { stale: true, source: "cache" } : {})),
    model("z-free"),
    model("z-best"),
    model("signal-eval-only"),
    model("signal-observed-zero"),
    model("signal-unknown"),
    model("tie-model"),
    model("tie-model", { source: "agent_route", virtual: true }),
    model("tie-model", { provider: "beta", provider_ref: betaRef }),
    model("z-expensive"),
  ];
  const catalogue: AdminModelsResponse = {
    generated_at: timestamp,
    models: [...models].reverse(),
    partial_failures: [
      {
        code: "provider_models_stale",
        message: "Public fixture stale",
        provider: "alpha",
        provider_ref: alphaRef,
      },
    ],
    providers: [
      {
        fetched_at: timestamp,
        model_count: 60,
        provider: "alpha",
        provider_ref: alphaRef,
        source: "live",
        stale: true,
        status: "ok",
      },
      {
        fetched_at: timestamp,
        model_count: 1,
        provider: "beta",
        provider_ref: betaRef,
        source: "live",
        stale: false,
        status: "ok",
      },
    ],
    request_id: "public-browser-model-sort",
  };
  const quality: ModelQualityResponse = {
    categories: [],
    since: "2026-10-07T03:00:00Z",
    models: [...new Set(models.map((item) => item.id))]
      .filter((id) => id !== "signal-unknown")
      .map((id) => ({
        model: id,
        categories: {},
        eval_pass_rate: 0.8,
        eval_samples: 5,
        golden_pass_rate: 0,
        golden_samples: 0,
        quality_score:
          id === "z-best"
            ? 100
            : id === "signal-eval-only"
              ? 95
              : id === "signal-observed-zero"
                ? 0
                : id === "tie-model"
                  ? 80
                  : 40,
        requests: id === "signal-eval-only" ? 0 : 10,
        success_rate:
          id === "signal-eval-only" || id === "signal-observed-zero" ? 0 : id === "z-best" ? 1 : 0.5,
      })),
  };
  const pricing: PricingResponse = {
    effective: Object.fromEntries(
      models
        .filter((item) => item.id !== "signal-unknown")
        .map((item) => [
          `${item.provider}/${item.id}`,
          {
            cached_input_krw_per_1m: 0,
            input_krw_per_1m: item.id === "z-free" ? 0 : item.id === "z-expensive" ? 9999 : 100,
            output_krw_per_1m: item.id === "z-best" ? 0 : item.id === "z-free" ? 9999 : 200,
          },
        ]),
    ),
    versions: [],
  };
  return { catalogue, quality, pricing };
}

async function install(context: BrowserContext) {
  const data = fixtures();
  const reads: Array<{ path: string; query: string }> = [];
  const writes: string[] = [];
  const unexpected: string[] = [];
  const paths = ["/admin/models", "/admin/models/quality", "/admin/pricing", "/admin/model-tags"];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = `${request.method()} ${url.pathname}`;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      unexpected.push(`external ${call}`);
      return json({ error: { message: "Synthetic fixture forbids external requests" } }, 501);
    }
    if (
      request.method() !== "GET" &&
      (url.pathname.startsWith("/admin/") ||
        url.pathname.startsWith("/auth/") ||
        url.pathname.startsWith("/v1/"))
    ) {
      writes.push(call);
      return json({ error: { message: "No writes in model catalogue exploration" } }, 501);
    }
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health" || url.pathname === "/ready") return json({ status: "ok" });
    if (paths.includes(url.pathname)) {
      reads.push({ path: url.pathname, query: url.search });
      if (url.pathname === "/admin/models") return json(data.catalogue);
      if (url.pathname === "/admin/models/quality") return json(data.quality);
      if (url.pathname === "/admin/pricing") return json(data.pricing);
      return json({ tags: [] });
    }
    if (/^\/(admin|auth|v1|mcp)(\/|$)/u.test(url.pathname)) {
      unexpected.push(call);
      return json({ error: { message: "Unexpected synthetic catalogue endpoint" } }, 501);
    }
    return route.continue();
  });
  return {
    reads,
    writes,
    unexpected,
    shrinkToOrdinary(count: number) {
      data.catalogue.models = data.catalogue.models.filter((item) =>
        ordinaryIds.slice(0, count).includes(item.id),
      );
      data.catalogue.providers.forEach((provider) => {
        provider.model_count = provider.provider_ref === alphaRef ? data.catalogue.models.length : 0;
      });
    },
  };
}

export const test = base.extend<{ modelGateway: Awaited<ReturnType<typeof install>> }>({
  modelGateway: async ({ context }, provide) => {
    await provide(await install(context));
  },
});
test.afterEach(async ({ modelGateway }, info) => {
  expect(modelGateway.writes).toEqual([]);
  expect(modelGateway.unexpected).toEqual([]);
  await info.attach("synthetic-model-catalogue-requests", {
    contentType: "application/json",
    body: JSON.stringify({
      reads: modelGateway.reads,
      writes: modelGateway.writes,
      unexpected: modelGateway.unexpected,
    }),
  });
});
