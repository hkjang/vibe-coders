import { expect, test, type Page, type Request } from "@playwright/test";

interface AxeRuntime {
  run: (root: Document) => Promise<{
    violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }>;
  }>;
}

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
  backend_version: "v0.81.0",
  ui_version: "e2e-v0.81.0",
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
      "system.health": true,
    },
  },
  roles: ["super_admin"],
  permissions: ["admin:read", "routing:read"],
  allowed_features: ["overview", "gateway.health", "system.health"],
  migration_registry: [
    {
      feature_id: "overview",
      title: "Overview",
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
      title: "Gateway Health",
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
      feature_id: "system.health",
      title: "System Health",
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
    "/app/system/health": "/admin#/ops-home",
  },
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
      score: 96,
      requests: 9_640,
      fallback_rate: 0.0039,
      p95_latency_ms: 1_280,
      average_latency_ms: 712.4,
    },
    {
      rank: 2,
      provider: "anthropic-fallback",
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
        phase: "closed",
        failures: 0,
        opens: 1,
        last_reason: "upstream timeout",
        last_failure_at: "2026-09-01T22:15:00Z",
      },
      {
        provider: "anthropic-fallback",
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
        return json(bootstrap);
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
  await expect(page.getByRole("heading", { name: "운영 Overview" })).toBeVisible();
  await expect(page.getByText("Gateway는 요청을 처리할 수 있으며, 운영 신호는")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "운영 Overview" })).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Gateway Health", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("table", { name: "선택 기간의 Provider 상태 점수 순위" }).getByText("openai-primary"),
  ).toBeVisible();
  await expect(page.getByText("96점", { exact: true })).toBeVisible();
  await expect(page.locator("#main-content").getByText("Read Only", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Legacy 상태 열기/ })).toHaveAttribute(
    "href",
    "/admin#/routing/health",
  );
  await expect.poll(() => routingWindows).toContain("7d");

  await page.reload();
  await expect(page).toHaveURL(/\/app\/gateway\/health\?range=7d$/);
  await expect(page.getByRole("heading", { name: "Gateway Health", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
});

test("opens and reloads the read-only System Health deep link", async ({ page }) => {
  await mockGateway(page);
  await page.goto("system/health");

  await expect(page.getByRole("heading", { name: "System Health", exact: true })).toBeVisible();
  await expect(page.getByText("Preview Read Only", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security posture" })).toBeVisible();
  await expect(page.getByText("78 GiB", { exact: true })).toBeVisible();
  await expect(page.getByText("openai-primary", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Legacy에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/ops-home",
  );

  await page.reload();
  await expect(page).toHaveURL(/\/app\/system\/health$/);
  await expect(page.getByRole("heading", { name: "System Health", exact: true })).toBeVisible();
  await expect(page.getByText("LOW", { exact: true })).toBeVisible();
});

test("meets automated browser accessibility checks on every Phase 1 health screen", async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await openOverview(page);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("gateway/health");
  await expect(page.getByRole("heading", { name: "Gateway Health", exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("system/health");
  await expect(page.getByRole("heading", { name: "System Health", exact: true })).toBeVisible();
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
  await expect(navigation.getByRole("link", { name: "Gateway Health Read Only" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "System Health Read Only" })).toBeVisible();
  await expect(page).toHaveScreenshot("navigation-mobile.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });
});
