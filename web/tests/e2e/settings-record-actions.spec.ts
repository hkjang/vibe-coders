import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";

const origin = "https://collector.example.invalid";
async function install(page: Page) {
  const base = await installSettingsWorkspace(page);
  base.bootstrap.backend_version = "v0.86.151";
  const state = {
    failWrite: false,
    failRead: false,
    denied: false,
    allowed: false,
    cleared: false,
    writes: [] as string[],
  };
  await page.route("**/admin/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (
      ![
        "/admin/tracking/violations",
        "/admin/tracking/violations/allow",
        "/admin/system-errors",
        "/admin/system-errors/clear",
      ].includes(path)
    )
      return route.fallback();
    const write = request.method() !== "GET";
    if (write) state.writes.push(`${request.method()} ${path}`);
    if (state.denied && !write)
      return route.fulfill({
        status: 403,
        json: { error: { code: "permission_denied", message: "private-detail" } },
      });
    if ((write && state.failWrite) || (!write && state.failRead))
      return route.fulfill({
        status: 503,
        headers: { "X-Request-ID": "public-record-action" },
        json: { error: { code: "unavailable", message: "private-detail" } },
      });
    if (write) {
      if (path.endsWith("/allow")) {
        expect(request.postDataJSON()).toEqual({ origin });
        state.allowed = true;
      } else state.cleared = true;
    }
    if (path.startsWith("/admin/system-errors"))
      return route.fulfill({
        json: write
          ? { status: "cleared" }
          : {
              errors: state.cleared
                ? []
                : [
                    {
                      id: "public-error",
                      component: "gateway",
                      error_message: "공개 예제 오류",
                      created_at: "2026-11-18T00:00:00Z",
                    },
                  ],
            },
      });
    return route.fulfill({
      json: {
        enabled: true,
        active: true,
        provider: "custom",
        allowed_hosts: state.allowed
          ? ["https://existing.example.invalid", origin]
          : ["https://existing.example.invalid"],
        violations: state.cleared
          ? []
          : [
              {
                origin,
                directive: "connect-src",
                page: "/app",
                count: 3,
                last_seen: "2026-11-18T00:00:00Z",
                allowed: state.allowed,
              },
            ],
      },
    });
  });
  return {
    ...base,
    state,
    check: () => {
      expect(base.writes).toEqual([]);
      expect(base.unexpected).toEqual([]);
    },
  };
}
const flows = [
  {
    tab: "tracking",
    trigger: `${origin} 허용`,
    confirm: "출처 허용",
    path: "POST /admin/tracking/violations/allow",
  },
  { tab: "tracking", trigger: "기록 비우기", confirm: "비우기", path: "DELETE /admin/tracking/violations" },
  { tab: "errors", trigger: "전체 비우기", confirm: "전체 비우기", path: "POST /admin/system-errors/clear" },
];
for (const flow of flows) {
  test(`${flow.path}: 키보드 확인과 취소, 실패 후 새 조회`, async ({ page }) => {
    const api = await install(page);
    await page.goto(`system/settings?tab=${flow.tab}`);
    const trigger = page.getByRole("button", { name: flow.trigger, exact: true });
    await expect(trigger).toBeEnabled();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(api.state.writes).toEqual([]);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    api.state.failWrite = true;
    await dialog.getByRole("button", { name: flow.confirm, exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("public-record-action");
    await expect(dialog).not.toContainText("private-detail");
    await expect(dialog.getByRole("button", { name: flow.confirm, exact: true })).toBeDisabled();
    expect(api.state.writes).toEqual([flow.path]);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(trigger).toBeDisabled();
    api.state.failWrite = false;
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(trigger).toBeEnabled();
    expect(api.state.writes).toEqual([flow.path]);
    await trigger.click();
    await dialog.getByRole("button", { name: flow.confirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.state.writes).toEqual([flow.path, flow.path]);
    api.check();
  });
}
for (const tab of ["tracking", "errors"]) {
  test(`${tab}: 읽기 전용 화면은 기록 변경을 허용하지 않는다`, async ({ page }) => {
    const api = await install(page);
    const feature = api.bootstrap.migration_registry.find((item) => item.feature_id === "system.settings");
    if (!feature) throw new Error("설정 기능이 없습니다.");
    feature.read_only = true;
    await page.goto(`system/settings?tab=${tab}`);
    const trigger = page.getByRole("button", {
      name: tab === "tracking" ? "기록 비우기" : "전체 비우기",
      exact: true,
    });
    await expect(trigger).toBeDisabled();
    await expect(page.getByText("이 화면은 읽기 전용입니다.", { exact: false })).toBeVisible();
    expect(api.state.writes).toEqual([]);
    api.check();
  });
  test(`${tab}: 조회 실패와 권한 거부를 빈 기록으로 혼동하지 않는다`, async ({ page }) => {
    const api = await install(page);
    api.state.failRead = true;
    await page.goto(`system/settings?tab=${tab}`);
    await expect(page.getByRole("alert").filter({ hasText: "public-record-action" })).toBeVisible();
    await expect(
      page.getByText(tab === "tracking" ? "차단된 출처가 없습니다." : "기록된 시스템 오류가 없습니다.", {
        exact: true,
      }),
    ).toHaveCount(0);
    api.state.failRead = false;
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(
      page.getByText(tab === "tracking" ? origin : "공개 예제 오류", { exact: true }),
    ).toBeVisible();
    api.state.denied = true;
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(page.getByText("기록 조회 권한 확인 필요", { exact: true })).toBeVisible();
    await expect(page.getByText(tab === "tracking" ? origin : "공개 예제 오류", { exact: true })).toHaveCount(
      0,
    );
    expect(api.state.writes).toEqual([]);
    api.check();
  });
}
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    for (const tab of ["tracking", "errors"] as const)
      test(`${tab} 확인 ${theme} ${width}: 대비·레이아웃·접근성`, async ({ page }) => {
        const api = await install(page);
        await page.clock.setFixedTime(new Date("2026-11-18T00:00:00Z"));
        await page.setViewportSize({ width, height: 960 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(`system/settings?tab=${tab}`);
        const trigger = page.getByRole("button", {
          name: tab === "tracking" ? `${origin} 허용` : "전체 비우기",
          exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const results = await page.evaluate(async () =>
          (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
        );
        expect(results.violations).toEqual([]);
        await expect(dialog).toHaveScreenshot(`record-review-${tab}-${theme}-${width}.png`);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        expect(api.state.writes).toEqual([]);
        api.check();
      });
