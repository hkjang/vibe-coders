import { expect, test, type Page } from "@playwright/test";

interface AxeRuntime {
  run: (root: Document) => Promise<{
    violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }>;
  }>;
}

const bootstrap = {
  backend_version: "v0.82.0",
  ui_version: "e2e-v0.82.0",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/gateway/models",
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
    id: "model-e2e-admin",
    email: "model-e2e@example.invalid",
    name: "Model E2E Admin",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read"],
    features: { "gateway.models": true },
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["gateway.models"],
  migration_registry: [
    {
      feature_id: "gateway.models",
      title: "Models",
      app_path: "/app/gateway/models",
      legacy_path: "/admin#/model-contracts",
      status: "preview_read_only",
      risk_level: "medium",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.82.0",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/gateway/models": "/admin#/model-contracts" },
};

const baseModel = {
  created: 1_700_000_000,
  deprecation: null,
  fetched_at: "2026-09-02T00:00:00Z",
  id: "shared-model",
  object: "model",
  owned_by: "openai",
  provider: "openai",
  shadowed: false,
  shadowed_by: "",
  source: "live",
  stale: false,
  virtual: false,
};

const models = {
  generated_at: "2026-09-02T00:00:00Z",
  models: [
    baseModel,
    { ...baseModel, source: "agent_route", virtual: true },
    {
      ...baseModel,
      id: "gpt-shadowed",
      shadowed: true,
      shadowed_by: "agent-route-priority",
    },
  ],
  partial_failures: [
    {
      code: "provider_models_unavailable",
      message: "Provider model catalogue is unavailable.",
      provider: "anthropic",
    },
  ],
  providers: [
    {
      fetched_at: "2026-09-02T00:00:00Z",
      model_count: 2,
      provider: "openai",
      source: "live",
      stale: false,
      status: "ok",
    },
    {
      fetched_at: "2026-09-02T00:00:00Z",
      model_count: 1,
      provider: "openai",
      source: "agent_route",
      stale: false,
      status: "ok",
    },
  ],
  request_id: "req-models-e2e",
};

const quality = {
  categories: ["coding"],
  models: [
    {
      categories: { coding: { pass_rate: 0.95, samples: 20 } },
      eval_pass_rate: 0.9,
      eval_samples: 20,
      golden_pass_rate: 0.95,
      golden_samples: 20,
      model: "shared-model",
      quality_score: 93,
      requests: 100,
      success_rate: 0.99,
    },
  ],
  since: "2026-08-26T00:00:00Z",
};

const pricing = {
  effective: {
    "shared-model": {
      cached_input_krw_per_1m: 100,
      input_krw_per_1m: 1_000,
      output_krw_per_1m: 2_000,
    },
  },
  versions: [],
};

const tags = {
  tags: [
    {
      avoid_for: "unreviewed production changes",
      good_for: "coding and analysis",
      model: "shared-model",
      risk_note: "Review generated code",
      updated_at: "2026-09-02T00:00:00Z",
      updated_by: "model-e2e-admin",
    },
  ],
};

async function mockModelGateway(page: Page): Promise<() => number> {
  let tagRequests = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Promise<void> =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });

    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/ready") return json({ status: "ready" });
    if (url.pathname === "/admin/models") return json(models);
    if (url.pathname === "/admin/models/quality") return json(quality);
    if (url.pathname === "/admin/pricing") return json(pricing);
    if (url.pathname === "/admin/model-tags") {
      tagRequests += 1;
      if (tagRequests <= 2) {
        return json(
          {
            error: { message: "Model usage tags are temporarily unavailable.", type: "server_error" },
            request_id: "req-tags-e2e",
          },
          503,
          { "X-Request-ID": "req-tags-e2e" },
        );
      }
      return json(tags);
    }

    if (request.resourceType() === "document" && url.pathname.startsWith("/app/")) {
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  return () => tagRequests;
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

test("keeps an exact model deep link across reload, restores focus, retries detail data, and passes axe", async ({
  page,
}) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const tagRequestCount = await mockModelGateway(page);
  await page.goto(
    "gateway/models?provider=openai&range=7d&model=shared-model&model_provider=openai&source=agent_route",
  );

  await expect(page.locator("h1", { hasText: "Models" })).toBeVisible();
  await expect(page.locator("button", { hasText: "7일" })).toHaveAttribute("aria-pressed", "true");
  let dialog = page.getByRole("dialog", { name: "shared-model" });
  await expect(dialog.getByText("agent route", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Virtual", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(
    /\/app\/gateway\/models\?provider=openai&range=7d&model=shared-model&model_provider=openai&source=agent_route$/,
  );

  await expect(dialog.getByText("Request ID: req-tags-e2e")).toBeVisible();
  await expect.poll(tagRequestCount).toBe(2);
  await dialog.getByRole("button", { name: "Model 사용 지침 상세 재시도" }).click();
  await expect(dialog.getByText("coding and analysis")).toBeVisible();
  await expect.poll(tagRequestCount).toBe(3);

  await page.reload();
  dialog = page.getByRole("dialog", { name: "shared-model" });
  await expect(dialog.getByText("agent route", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/model=shared-model&model_provider=openai&source=agent_route$/);
  await expect(dialog.getByText("coding and analysis")).toBeVisible();
  await expect.poll(tagRequestCount).toBe(4);
  expect(await axeViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const agentRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "shared-model", exact: true }) })
    .filter({ hasText: "agent route" });
  const trigger = agentRow.getByRole("link", { name: "shared-model", exact: true });
  await trigger.click();
  dialog = page.getByRole("dialog", { name: "shared-model" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.dataset.modelTrigger ?? document.activeElement.outerHTML)
          : "no active element",
      ),
    )
    .toContain("agent_route");

  await expect(page.getByText("Request ID: req-models-e2e")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("distinguishes a partial failure from a missing model when the provider is unspecified", async ({
  page,
}) => {
  await mockModelGateway(page);
  await page.goto("gateway/models?model=claude-4");

  const dialog = page.getByRole("dialog", { name: "claude-4" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Provider Model 카탈로그를 확인할 수 없습니다.")).toBeVisible();
  await expect(dialog.getByText(/provider_models_unavailable/)).toBeVisible();
  await expect(dialog.getByText("Request ID: req-models-e2e")).toBeVisible();
  await expect(dialog.getByText("Model을 찾을 수 없습니다.")).toBeHidden();
});

test("requires an exact Provider and source for an ambiguous model deep link", async ({ page }) => {
  await mockModelGateway(page);
  await page.goto("gateway/models?model=shared-model");

  const dialog = page.getByRole("dialog", { name: "shared-model" });
  await expect(dialog.getByText("Provider와 source를 선택해 주세요.")).toBeVisible();
  await dialog.getByRole("link", { name: "openai · agent route" }).click();
  await expect(dialog.getByText("Virtual", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/model_provider=openai&source=agent_route/);
});
