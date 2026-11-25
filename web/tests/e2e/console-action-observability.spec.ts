import { expect, test, type Page, type Request } from "@playwright/test";
import process from "node:process";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace, runtimeKey } from "../fixtures/settings-workspace-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

const version = process.env.APP_UI_ACTIONS_VERSION ?? "v0.86.181";
const row = {
  feature_id: "system.settings",
  action: "run_request",
  ui_version: "v999999.999999.999999",
  success: 3,
  rejected: 1,
  unknown: 10,
};
const summary = {
  enabled: true,
  days: 7,
  from: "2026-11-13T00:00:00Z",
  to: "2026-11-20T00:00:00Z",
  retention_days: 30,
  event_limit: 10_000,
  group_limit: 100,
  success: 3,
  rejected: 1,
  unknown: 10,
  other: { success: 0, rejected: 0, unknown: 0 },
  groups: [row],
};
function observations(page: Page) {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/admin/ui-actions/events") requests.push(request);
  });
  return requests;
}
async function install(page: Page, enabled: boolean, backendVersion = version) {
  const state = await installSettingsWorkspace(page);
  state.bootstrap.backend_version = backendVersion;
  state.bootstrap.ui.telemetry_enabled = enabled;
  // The business-write fixture stays deterministic; observations reach the isolated Go server.
  await page.route(/\/admin\/ui-(actions|diagnostics|telemetry)\//, (route) => route.continue());
  return state;
}
async function save(page: Page) {
  await page.goto(`system/settings?tab=runtime&setting=${runtimeKey}`);
  const dialog = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await dialog.getByLabel("새 값", { exact: true }).selectOption("false");
  await dialog.getByLabel("변경 사유").fill("PRIVATE_ACTION_PAYLOAD");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
}
for (const [status, outcome, code] of [
  [200, "success", ""],
  [409, "rejected", ""],
  [503, "unknown", ""],
  [503, "success", "setting_reload_pending"],
] as const)
  test(`실제 Go 관측 수집과 저장 결과 ${status} · ${outcome}`, async ({ page, request }) => {
    test.skip(process.env.APP_UI_ACTIONS_LIVE !== "1", "격리된 Go embed에서 검증합니다.");
    const state = await install(page, true);
    if (status !== 200)
      await page.route(`**/admin/settings/by-key/${runtimeKey}`, (route) =>
        route.fulfill({ status, json: { error: { message: "PRIVATE_SERVER_MESSAGE", code } } }),
      );
    const sent = observations(page);
    const before = await request.get("/admin/ui-actions/summary");
    const baseline = (await before.json()) as Record<string, number>;
    const intake = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/ui-actions/events",
    );
    await save(page);
    expect((await intake).status()).toBe(204);
    expect(sent).toHaveLength(1);
    const observation = sent[0];
    expect(observation?.postDataJSON()).toEqual({
      feature_id: "system.settings",
      action: "save",
      outcome,
      event_id: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(observation?.headers()["x-vibe-ui-version"]).toBe(
      process.env.APP_UI_ACTIONS_HEADER_VERSION ?? version,
    );
    expect(observation?.headers()["referer"]).toBeUndefined();
    expect(observation?.postData()).not.toMatch(/PRIVATE|cache|reason|value/);
    await expect
      .poll(async () => {
        const result = await request.get("/admin/ui-actions/summary");
        const data = (await result.json()) as Record<string, number>;
        return data[outcome] ?? 0;
      })
      .toBeGreaterThan(baseline[outcome] ?? 0);
    const result = await request.get("/admin/ui-actions/summary");
    expect(await result.text()).not.toMatch(/PRIVATE|cache.chat_enabled/);
    expect(state.unexpected).toEqual([]);
  });
for (const mode of ["old", "off"] as const)
  test(`${mode} 상태에서 저장해도 작업 결과를 전송하지 않는다`, async ({ page }) => {
    const state = await install(page, mode === "old", mode === "old" ? "v0.86.180" : version);
    const sent = observations(page);
    await save(page);
    await expect(page.getByRole("dialog", { name: runtimeKey, exact: true })).toBeHidden();
    expect(state.writes).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`작업 결과 표의 긴 버전과 초점 ${width}px ${theme}`, async ({ page }) => {
      const state = await install(page, false);
      await page.route("**/admin/ui-telemetry/summary*", (route) =>
        route.fulfill({
          json: {
            enabled: false,
            days: 7,
            from: summary.from,
            to: summary.to,
            retention_days: 30,
            visit_limit: 100_000,
            features: [],
            load_metrics_available: true,
            load_limit_ms: 120_000,
            version_limit: 20,
            other_version_visits: 0,
            versions: [],
          },
        }),
      );
      await page.route("**/admin/ui-actions/summary*", (route) => route.fulfill({ json: summary }));
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date("2026-11-20T00:00:00Z"));
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("system/settings?tab=console");
      const trigger = page.getByRole("button", { name: "작업 결과 열기", exact: true });
      await trigger.focus();
      await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "콘솔 작업 결과", exact: true });
      await expect(dialog.getByText(/완료율 75% · 완료 3건 · 거부 1건 · 확인 불가 10건/)).toBeVisible();
      const region = dialog.getByRole("region", { name: "콘솔 기능별 작업 결과", exact: true });
      await expectCellBoundaries(region.getByRole("table"));
      await region.focus();
      await expect(region).toBeFocused();
      const a11y = await page.evaluate(async () => {
        const root = document.querySelector('[role="dialog"]');
        if (!root) throw new Error("Missing dialog");
        return (window as unknown as { axe: { run: (element: Element) => Promise<AxeResults> } }).axe.run(
          root,
        );
      });
      expect(a11y.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog
        .getByRole("region", { name: "콘솔 작업 결과 내용", exact: true })
        .evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
      await expect(page).toHaveScreenshot(`console-actions-${theme}-${width}.png`, {
        animations: "disabled",
      });
      // Native keyboard scrolling can continue after an instant programmatic
      // reset. Capture the initial layout before testing actual scroll motion.
      if (width === 390) {
        await region.press("ArrowRight");
        await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(state.unexpected).toEqual([]);
    });
