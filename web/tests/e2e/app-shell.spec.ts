import { expect, test, type Page, type Request } from "@playwright/test";

interface AxeRuntime {
  run: (root: Document) => Promise<{
    violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }>;
  }>;
}

const providerRef = (seed: string): string =>
  `prv_${[...seed]
    .map((character) => character.charCodeAt(0).toString(36))
    .join("")
    .padStart(43, "x")
    .slice(-43)}`;

async function axeViolations(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeRuntime }).axe;
    const result = await axe.run(document);
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  });
}

const opsStatus = {
  generated_at: "2026-09-02T03:59:30Z",
  providers: [
    {
      provider: "openai-primary",
      provider_ref: providerRef("openai-primary"),
      score: 96,
      requests: 9_640,
      average_latency_ms: 712.4,
      p95_latency_ms: 1_280,
      timeouts: 3,
      rate_429: 4,
      rate_5xx: 2,
      fallbacks: 38,
      fallback_rate: 0.0039,
    },
    {
      provider: "anthropic-fallback",
      provider_ref: providerRef("anthropic-fallback"),
      score: 91,
      requests: 3_200,
      average_latency_ms: 884.2,
      p95_latency_ms: 1_640,
      timeouts: 2,
      rate_429: 1,
      rate_5xx: 1,
      fallbacks: 12,
      fallback_rate: 0.0038,
    },
  ],
  logging: { queue_depth: 4, written: 12_836, dropped: 0 },
  fallback: {
    path: "/var/lib/vibe-coders/fallback.jsonl",
    exists: true,
    lines: 18,
    bytes: 18_432,
    modified_at: "2026-09-02T03:58:15Z",
  },
  security: {
    auth_enabled: true,
    dev_secret: false,
    raw_prompts_logged: false,
    raw_bodies_logged: false,
    pricing_configured: true,
  },
  disk: {
    path: "/var/lib/vibe-coders",
    available: true,
    free_bytes: 83_751_780_352,
    total_bytes: 128_849_018_880,
    used_percent: 35,
  },
};

const bootstrap = {
  backend_version: "v0.82.1",
  ui_version: "e2e-v0.82.1",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/overview",
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
    id: "e2e-super-admin",
    email: "operator@example.invalid",
    name: "E2E Operator",
    role: "super_admin",
    roles: ["super_admin"],
    team_id: "platform",
    scopes: ["admin:read", "routing:read"],
    features: {
      overview: true,
      "gateway.health": true,
      "gateway.models": true,
      "gateway.providers": true,
      "system.health": true,
    },
  },
  roles: ["super_admin"],
  permissions: ["admin:read", "routing:read"],
  allowed_features: ["overview", "gateway.health", "gateway.models", "gateway.providers", "system.health"],
  migration_registry: [
    {
      feature_id: "overview",
      title: "통합 현황",
      app_path: "/app/overview",
      legacy_path: "/admin#/dashboard",
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["super_admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.80.0",
      available: true,
    },
    {
      feature_id: "gateway.health",
      title: "게이트웨이 상태",
      app_path: "/app/gateway/health",
      legacy_path: "/admin#/routing/health",
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "routing:read",
      read_only: true,
      enabled_roles: ["super_admin", "admin", "ai_admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.81.0",
      available: true,
    },
    {
      feature_id: "gateway.providers",
      title: "AI 공급자",
      app_path: "/app/gateway/providers",
      legacy_path: "/admin#/settings",
      status: "preview_read_only",
      risk_level: "medium",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["super_admin", "admin", "ai_admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.82.0",
      available: true,
    },
    {
      feature_id: "gateway.models",
      title: "모델",
      app_path: "/app/gateway/models",
      legacy_path: "/admin#/model-contracts",
      status: "preview_read_only",
      risk_level: "medium",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["super_admin", "admin", "ai_admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.82.0",
      available: true,
    },
    {
      feature_id: "system.health",
      title: "시스템 상태",
      app_path: "/app/system/health",
      legacy_path: "/admin#/ops-home",
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["super_admin", "admin", "ops_admin", "ai_admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.81.0",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: {
    "/app/overview": "/admin#/dashboard",
    "/app/gateway/health": "/admin#/routing/health",
    "/app/gateway/models": "/admin#/model-contracts",
    "/app/gateway/providers": "/admin#/settings",
    "/app/system/health": "/admin#/ops-home",
  },
};

const providers = {
  providers: [
    {
      name: "openai-primary",
      provider_ref: providerRef("openai-primary"),
      base_url: "https://openai.example/v1?api-version=2026-01-01",
      api_key_configured: true,
      timeout_ms: 30_000,
      enabled: true,
      model_patterns: "gpt-*",
      failover_group: "premium",
      priority: 10,
      created_at: "2026-08-01T09:00:00Z",
    },
    {
      name: "anthropic-fallback",
      provider_ref: providerRef("anthropic-fallback"),
      base_url: "https://anthropic.example/v1",
      api_key_configured: true,
      timeout_ms: 30_000,
      enabled: true,
      model_patterns: "claude-*",
      failover_group: "premium",
      priority: 20,
      created_at: "2026-08-02T09:00:00Z",
    },
    ...Array.from({ length: 9 }, (_, index) => {
      const ordinal = index + 3;
      const suffix = String(ordinal).padStart(2, "0");
      return {
        name: `provider-${suffix}`,
        provider_ref: providerRef(`provider-${suffix}`),
        base_url: `https://provider-${suffix}.example/v1`,
        api_key_configured: true,
        timeout_ms: 15_000,
        enabled: true,
        model_patterns: `model-${suffix}-*`,
        failover_group: "standard",
        priority: ordinal * 10,
        created_at: "2026-08-03T09:00:00Z",
      };
    }),
  ],
};

const providerSLO = {
  slos: [
    {
      provider: "openai-primary",
      provider_ref: providerRef("openai-primary"),
      availability_target: 0.99,
      p95_latency_target_ms: 1_500,
      error_rate_target: 0.02,
      fallback_rate_target: 0.05,
      enabled: true,
      note: "production objective",
      updated_at: "2026-09-02T03:58:00Z",
    },
  ],
  evaluations: [
    {
      provider: "openai-primary",
      provider_ref: providerRef("openai-primary"),
      requests: 9_640,
      enabled: true,
      breached: false,
      metrics: {
        availability: { target: 0.99, actual: 0.999, breached: false, enforced: true },
        p95_latency_ms: { target: 1_500, actual: 1_280, breached: false, enforced: true },
        error_rate: { target: 0.02, actual: 0.001, breached: false, enforced: true },
        fallback_rate: { target: 0.05, actual: 0.0039, breached: false, enforced: true },
      },
    },
  ],
  since: "2026-09-01T04:00:00Z",
};

const stats = {
  total_requests: 12_840,
  total_tokens: 9_530_000,
  total_cost_krw: 428_751,
  average_latency_ms: 842.4,
  by_ip: [
    {
      key: "10.0.0.10",
      requests: 12_840,
      tokens: 9_530_000,
      cost_krw: 428_751,
      average_latency_ms: 842.4,
    },
  ],
  by_model: [
    {
      key: "gpt-5.6",
      requests: 12_840,
      tokens: 9_530_000,
      cost_krw: 428_751,
      average_latency_ms: 842.4,
    },
  ],
  by_language: [{ language: "ko", requests: 12_840, average_confidence: 0.98 }],
  by_status: [
    { class: "2xx", requests: 12_642 },
    { class: "4xx", requests: 148 },
    { class: "5xx", requests: 50 },
  ],
  top_users: [
    {
      api_key_id: "key-e2e",
      name: "Operations",
      owner: "platform",
      team: "platform",
      status: "active",
      requests: 12_840,
      tokens: 9_530_000,
      cost_krw: 428_751,
      average_latency_ms: 842.4,
      last_seen: "2026-09-02T03:59:00Z",
    },
  ],
  latency_quantiles: { p50: 620, p95: 1_540, p99: 2_840 },
  first_chunk_quantiles: { p50: 180, p95: 420, p99: 760 },
  cache: {
    entries: 8_230,
    bytes: 134_217_728,
    total_hits: 4_822,
    top_models: [{ model: "gpt-5.6", entries: 8_230, hits: 4_822 }],
  },
  failover_total: 50,
  cache_hits: 4_822,
  cache_misses: 1_208,
};

const opsRisk = {
  risk: { score: 8, tier: "low", factors: [] },
  status: opsStatus,
};

const routingHealth = {
  since: "2026-09-01T04:00:00Z",
  until: "2026-09-02T04:00:00Z",
  threshold: 70,
  providers: opsStatus.providers,
  ranking: [
    {
      rank: 1,
      provider: "openai-primary",
      provider_ref: providerRef("openai-primary"),
      score: 96,
      requests: 9_640,
      fallback_rate: 0.0039,
      p95_latency_ms: 1_280,
      average_latency_ms: 712.4,
    },
    {
      rank: 2,
      provider: "anthropic-fallback",
      provider_ref: providerRef("anthropic-fallback"),
      score: 91,
      requests: 3_200,
      fallback_rate: 0.0038,
      p95_latency_ms: 1_640,
      average_latency_ms: 884.2,
    },
  ],
  degraded: [],
  alerts: [],
  trend: [
    {
      since: "2026-09-02T03:00:00Z",
      until: "2026-09-02T04:00:00Z",
      providers: opsStatus.providers,
    },
  ],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    states: [
      {
        provider: "openai-primary",
        provider_ref: providerRef("openai-primary"),
        phase: "closed",
        failures: 0,
        opens: 1,
        last_reason: "upstream timeout",
        last_failure_at: "2026-09-01T22:15:00Z",
      },
      {
        provider: "anthropic-fallback",
        provider_ref: providerRef("anthropic-fallback"),
        phase: "closed",
        failures: 0,
        opens: 0,
      },
    ],
    shared: true,
    instance_id: "gateway-e2e-01",
  },
};

interface MockGatewayOptions {
  bootstrapPayload?: unknown;
  onRoutingRequest?: (request: Request) => void;
}

async function mockGateway(page: Page, options: MockGatewayOptions = {}): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    switch (url.pathname) {
      case "/admin/ui-bootstrap":
        return json(options.bootstrapPayload ?? bootstrap);
      case "/health":
        return json({ status: "ok" });
      case "/ready":
        return json({ status: "ready" });
      case "/admin/stats":
        return json(stats);
      case "/admin/ops/status":
        return json(opsStatus);
      case "/admin/ops/risk":
        return json(opsRisk);
      case "/admin/routing/health":
        options.onRoutingRequest?.(request);
        return json(routingHealth);
      case "/admin/providers":
        return json(providers);
      case "/admin/providers/slo":
        return json(providerSLO);
      case "/admin/models":
        return json({
          request_id: "req-models-shell",
          generated_at: "2026-09-02T04:00:00Z",
          models: [],
          providers: [],
          partial_failures: [],
        });
      case "/admin/models/quality":
        return json({ since: "2026-09-01T04:00:00Z", categories: [], models: [] });
      case "/admin/pricing":
        return json({ effective: {}, versions: [] });
      case "/admin/model-tags":
        return json({ tags: [] });
      default:
        break;
    }

    if (request.resourceType() === "document" && url.pathname.startsWith("/app/")) {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy":
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
            "script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; " +
            "style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
        },
      });
      return;
    }

    await route.continue();
  });
}

async function openOverview(page: Page, colorScheme: "dark" | "light" = "light"): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-09-02T04:00:00.000Z"));
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await mockGateway(page);
  await page.goto("overview");
  await expect(page.getByRole("heading", { name: "운영 개요" })).toBeVisible();
  await expect(page.getByText("게이트웨이는 요청을 처리할 수 있으며, 운영 신호는")).toBeVisible();
  await expect(page.getByText("12,840")).toBeVisible();
  await expect(page.getByText("₩428,751")).toBeVisible();
}

test("opens the command palette on a deep link without CSP or external asset errors", async ({ page }) => {
  const policyErrors: string[] = [];
  const assetRequests: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy|refused to (apply|execute)/i.test(message.text())
    ) {
      policyErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (["font", "image", "script", "stylesheet"].includes(request.resourceType())) {
      assetRequests.push(request.url());
    }
  });
  await mockGateway(page);
  await page.goto("overview");
  await expect(page.getByRole("heading", { name: "운영 개요" })).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "메뉴 검색" })).toBeFocused();
  expect(policyErrors).toEqual([]);
  const appOrigin = new URL(page.url()).origin;
  expect(assetRequests.filter((requestUrl) => new URL(requestUrl).origin !== appOrigin)).toEqual([]);
});

test("opens and reloads Gateway Health at a URL-backed range", async ({ page }) => {
  const routingWindows: string[] = [];
  await mockGateway(page, {
    onRoutingRequest: (request) => {
      routingWindows.push(new URL(request.url()).searchParams.get("window") ?? "");
    },
  });

  await page.goto("gateway/health?range=7d");
  await expect(page.getByRole("heading", { name: "게이트웨이 상태", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("table", { name: "선택 기간의 공급자 상태 점수 순위" }).getByText("openai-primary"),
  ).toBeVisible();
  await expect(page.getByText("96점", { exact: true })).toBeVisible();
  await expect(page.locator("#main-content").getByText("읽기 전용", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /기존 상태 화면 열기/ })).toHaveAttribute(
    "href",
    "/admin#/routing/health",
  );
  await expect.poll(() => routingWindows).toContain("7d");

  await page.reload();
  await expect(page).toHaveURL(/\/app\/gateway\/health\?range=7d$/);
  await expect(page.getByRole("heading", { name: "게이트웨이 상태", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
});

test("restores Provider list filters, pagination, and a deep-linked dialog across reload", async ({
  page,
}) => {
  const routingWindows: string[] = [];
  await mockGateway(page, {
    onRoutingRequest: (request) => {
      routingWindows.push(new URL(request.url()).searchParams.get("window") ?? "");
    },
  });

  await page.goto("gateway/providers?q=example&status=enabled&range=7d&page=2");
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" });
  await expect(table.getByRole("link", { name: "provider-11" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "공급자" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "운영 상태" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "공급자 연결 설정과 운영 상태 페이지" })).toBeVisible();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "공급자 검색" })).toHaveValue("example");
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("enabled");
  await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
  await table.getByRole("link", { name: "provider-11" }).click();
  const dialog = page.getByRole("dialog", { name: "provider-11" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("https://provider-11.example/v1")).toBeVisible();
  await expect.poll(() => routingWindows).toContain("7d");
  await expect(page).toHaveURL(
    new RegExp(
      `/app/gateway/providers\\?q=example&status=enabled&range=7d&page=2&provider=${providerRef("provider-11")}$`,
    ),
  );

  await page.reload();
  await expect(page).toHaveURL(
    new RegExp(
      `/app/gateway/providers\\?q=example&status=enabled&range=7d&page=2&provider=${providerRef("provider-11")}$`,
    ),
  );
  await expect(page.getByRole("dialog", { name: "provider-11" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "provider-11" })).toBeHidden();
  await expect(page).toHaveURL(/\?q=example&status=enabled&range=7d&page=2$/);
  await expect(page.locator("#main-content")).toBeFocused();
});

test("restores focus to the Provider row trigger after Escape", async ({ page }) => {
  await mockGateway(page);
  await page.goto("gateway/providers");

  const trigger = page.getByRole("link", { name: "openai-primary" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "openai-primary" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "openai-primary" })).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-provider-trigger") ?? ""))
    .toBe(providerRef("openai-primary"));
});

test("never fetches routing health for Provider without routing:read", async ({ page }) => {
  let routingRequests = 0;
  const bootstrapWithoutRouting = {
    ...bootstrap,
    user: { ...bootstrap.user, scopes: ["admin:read"] },
    permissions: ["admin:read"],
  };
  await mockGateway(page, {
    bootstrapPayload: bootstrapWithoutRouting,
    onRoutingRequest: () => {
      routingRequests += 1;
    },
  });

  await page.goto("gateway/providers?range=30d");
  const table = page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" });
  await expect(table).toBeVisible();
  await expect(table.getByText("정상", { exact: true })).toBeVisible();
  await expect(page.getByText(/SLO 평가만 표시합니다/)).toBeVisible();
  expect(routingRequests).toBe(0);
});

test("replaces legacy short Gateway paths with only allowed query and safe hash", async ({ page }) => {
  await mockGateway(page);

  await page.goto("providers?team=platform#connections");
  await expect(page).toHaveURL(/\/app\/gateway\/providers#connections$/);
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /기존 화면에서 열기/ })).toHaveAttribute(
    "href",
    "/admin#/settings",
  );

  await page.goto("models?status=deprecated#pricing");
  await expect(page).toHaveURL(/\/app\/gateway\/models\?status=deprecated#pricing$/);
  await expect(page.getByRole("heading", { name: "모델", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /기존 화면에서 열기/ })).toHaveAttribute(
    "href",
    "/admin#/model-contracts",
  );
});

test("removes secret and arbitrary route query state before rendering the Provider page", async ({
  page,
}) => {
  await mockGateway(page);

  await page.goto(
    "gateway/providers?q=sk-proj-private12345678&status=enabled&token=private&team=platform#token=private",
  );
  await expect(page.getByRole("heading", { name: "공급자", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/gateway\/providers\?status=enabled$/);
  const search = page.getByRole("textbox", { name: "공급자 검색" });
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("인증정보로 보이는 검색어");

  await search.fill("Bearer another-private-value");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page).toHaveURL(/\/app\/gateway\/providers\?status=enabled$/);
});

test("opens and reloads the read-only System Health deep link", async ({ page }) => {
  await mockGateway(page);
  await page.goto("system/health");

  await expect(page.getByRole("heading", { name: "시스템 상태", exact: true })).toBeVisible();
  await expect(page.getByText("읽기 전용 미리보기", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "보안 상태" })).toBeVisible();
  await expect(page.getByText("78 GiB", { exact: true })).toBeVisible();
  await expect(page.getByText("openai-primary", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/ops-home",
  );

  await page.reload();
  await expect(page).toHaveURL(/\/app\/system\/health$/);
  await expect(page.getByRole("heading", { name: "시스템 상태", exact: true })).toBeVisible();
  await expect(page.getByText("낮음", { exact: true })).toBeVisible();
});

test("meets automated browser accessibility checks on every Phase 1 screen", async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await openOverview(page);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("gateway/health");
  await expect(page.getByRole("heading", { name: "게이트웨이 상태", exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("system/health");
  await expect(page.getByRole("heading", { name: "시스템 상태", exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("gateway/providers");
  await expect(page.getByRole("table", { name: "공급자 연결 설정과 운영 상태" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("link", { name: "openai-primary" }).click();
  await expect(page.getByRole("dialog", { name: "openai-primary" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("keeps the desktop Overview stable in light and dark themes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openOverview(page);
  await expect(page).toHaveScreenshot("overview-light.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveScreenshot("overview-dark.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });
});

test("keeps the mobile Overview and navigation drawer stable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOverview(page);
  await expect(page).toHaveScreenshot("overview-mobile.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });

  await page.getByRole("button", { name: "탐색 메뉴 열기" }).click();
  const navigation = page.getByRole("dialog", { name: "주 메뉴" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "게이트웨이 상태 읽기 전용" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "시스템 상태 읽기 전용" })).toBeVisible();
  await expect(page).toHaveScreenshot("navigation-mobile.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });
});
