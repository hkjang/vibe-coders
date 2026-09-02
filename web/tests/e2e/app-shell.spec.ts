import { expect, test, type Page } from "@playwright/test";

const bootstrap = {
  backend_version: "v0.80.0",
  ui_version: "e2e",
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
    id: "legacy-admin",
    email: "",
    role: "super_admin",
    roles: ["super_admin"],
    team_id: "",
    scopes: ["admin:read"],
    features: {},
  },
  roles: ["super_admin"],
  permissions: ["admin:read"],
  allowed_features: ["overview"],
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
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/overview": "/admin#/dashboard" },
};

async function mockGateway(page: Page): Promise<void> {
  await page.route("**/admin/ui-bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrap) }),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) }),
  );
  await page.route("**/app/**", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
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
  });
}

async function openOverview(page: Page, colorScheme: "dark" | "light" = "light"): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-09-02T04:00:00.000Z"));
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await mockGateway(page);
  await page.goto("overview");
  await expect(page.getByRole("heading", { name: "운영 Overview" })).toBeVisible();
  await expect(page.getByText("Gateway가 요청을 처리할 준비가 되었습니다.")).toBeVisible();
}

test("opens the command palette on a deep link without CSP console errors", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy|refused to (apply|execute)/i.test(message.text())
    ) {
      cspErrors.push(message.text());
    }
  });
  await mockGateway(page);
  await page.goto("overview");
  await expect(page.getByRole("heading", { name: "운영 Overview" })).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "메뉴 검색" })).toBeFocused();
  expect(cspErrors).toEqual([]);
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
  await expect(page.getByRole("dialog", { name: "주 메뉴" })).toBeVisible();
  await expect(page).toHaveScreenshot("navigation-mobile.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });
});
