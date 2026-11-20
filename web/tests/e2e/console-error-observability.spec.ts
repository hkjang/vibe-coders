import { expect, test, type Page, type Request } from "@playwright/test";
import process from "node:process";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

const row = {
  feature_id: "system.settings",
  kind: "api_error",
  ui_version: "v0.86.180",
  endpoint: "/admin/requests/{id}/io",
  method: "GET",
  status: 503,
  request_id: "",
  failure: "http",
  boundary: "",
};
const summary = {
  enabled: true,
  days: 7,
  from: "2026-11-13T00:00:00Z",
  to: "2026-11-20T00:00:00Z",
  retention_days: 30,
  event_limit: 10_000,
  group_limit: 100,
  recent_limit: 20,
  total: 2,
  other_group_events: 0,
  groups: [{ ...row, events: 2 }],
  recent: [{ ...row, received_at: "2026-11-19T00:00:00Z", request_id: "trace_" + "a".repeat(32) }],
};

function diagnostics(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/admin/ui-diagnostics/events") requests.push(request);
  });
  return requests;
}

test("실제 수집 API가 오류의 경로 형식과 상태만 보존하고 원문은 기록하지 않는다", async ({
  page,
  request,
}) => {
  test.skip(process.env.APP_UI_DIAGNOSTICS_LIVE !== "1", "격리된 Go embed 실행에서 검증합니다.");
  const sent = diagnostics(page);
  await page.route("**/admin/settings/effective", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Content-Type": "application/json", "X-Request-ID": "trace_" + "b".repeat(32) },
      body: JSON.stringify({ error: { message: "PRIVATE_PROMPT_AND_SECRET", code: "private-code" } }),
    }),
  );
  await page.goto("system/settings?tab=runtime");
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const fault = sent.find((entry) => entry.postDataJSON().endpoint === "/admin/settings/effective");
  expect(fault?.postDataJSON()).toMatchObject({
    kind: "api_error",
    feature_id: "system.settings",
    method: "GET",
    status: 503,
    request_id: "trace_" + "b".repeat(32),
  });
  expect(fault?.headers()["x-vibe-ui-version"]).toBe("v0.86.180");
  expect(fault?.headers()["referer"]).toBeUndefined();
  expect(fault?.postData()).not.toMatch(/PRIVATE|private-code|runtime|\/app/);
  await expect
    .poll(async () => {
      const result = await request.get("/admin/ui-diagnostics/summary");
      expect(result.ok()).toBe(true);
      return ((await result.json()) as typeof summary).recent.some(
        (entry) => entry.request_id === "trace_" + "b".repeat(32),
      );
    })
    .toBe(true);
  const result = await request.get("/admin/ui-diagnostics/summary");
  expect(await result.text()).not.toContain("PRIVATE_PROMPT_AND_SECRET");
  await page.unroute("**/admin/settings/effective");
  await page.goto("system/settings?tab=console");
  await page.getByRole("button", { name: "오류 관측 열기", exact: true }).click();
  await expect(page.getByRole("region", { name: "최근 콘솔 오류", exact: true })).toContainText(
    "trace_" + "b".repeat(32),
  );
});

for (const phase of ["load", "render"] as const)
  test(`실제 화면 ${phase} 오류는 종류만 전송하고 오류 원문과 스택을 로그에 남기지 않는다`, async ({
    page,
    request,
  }) => {
    test.skip(process.env.APP_UI_DIAGNOSTICS_LIVE !== "1", "격리된 Go embed 실행에서 검증합니다.");
    const sent = diagnostics(page);
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.route(/\/app\/assets\/SystemSettingsPage-[^/]+\.js$/, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body:
          phase === "load"
            ? 'throw new TypeError("PRIVATE_COMPONENT_PROMPT");'
            : 'export function SystemSettingsPage() { throw new TypeError("PRIVATE_COMPONENT_PROMPT"); }',
      }),
    );
    await page.goto("system/settings?tab=console");
    await expect(page.getByRole("heading", { name: "화면 오류", exact: true })).toBeVisible();
    await expect.poll(() => sent.some((entry) => entry.postDataJSON().kind === "js_error")).toBe(true);
    expect(sent.filter((entry) => entry.postDataJSON().kind === "js_error")).toHaveLength(1);
    const event = sent.find((entry) => entry.postDataJSON().kind === "js_error");
    expect(event?.postDataJSON()).toMatchObject({
      kind: "js_error",
      boundary: "route",
      failure: "type",
      feature_id: "system.settings",
    });
    expect(event?.postData()).not.toMatch(/PRIVATE|stack|message/);
    expect(consoleErrors.join(" ")).not.toContain("PRIVATE_COMPONENT_PROMPT");
    await expect
      .poll(async () => {
        const result = await request.get("/admin/ui-diagnostics/summary");
        return ((await result.json()) as typeof summary).recent.some((entry) => entry.kind === "js_error");
      })
      .toBe(true);
    const legacy = await request.get("/admin");
    expect(legacy.status()).toBe(200);
  });

for (const mode of ["old", "off"] as const)
  test(`${mode} 상태에서는 오류를 수집하지 않는다`, async ({ page }) => {
    const api = await installSettingsWorkspace(page);
    api.bootstrap.backend_version = mode === "old" ? "v0.86.179" : "v0.86.180";
    api.bootstrap.ui.telemetry_enabled = mode === "old";
    const sent = diagnostics(page);
    await page.route("**/admin/settings/effective", (route) =>
      route.fulfill({ status: 503, json: { error: { message: "unavailable" } } }),
    );
    await page.goto("system/settings?tab=runtime");
    await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible();
    expect(sent).toEqual([]);
  });

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`오류 관측 표와 키보드 초점 ${width}px ${theme}`, async ({ page }) => {
      const api = await installSettingsWorkspace(page);
      api.bootstrap.backend_version = "v0.86.180";
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
      await page.route("**/admin/ui-diagnostics/summary*", (route) => route.fulfill({ json: summary }));
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date("2026-11-20T00:00:00Z"));
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("system/settings?tab=console");
      const trigger = page.getByRole("button", { name: "오류 관측 열기", exact: true });
      await trigger.focus();
      await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "콘솔 오류 관측", exact: true });
      await expect(dialog.getByText(/관측된 오류 2건/)).toBeVisible();
      for (const name of ["콘솔 오류 유형별 집계", "최근 콘솔 오류"]) {
        const region = dialog.getByRole("region", { name, exact: true });
        await expectCellBoundaries(region.getByRole("table"));
        await region.focus();
        await expect(region).toBeFocused();
        if (width === 390) {
          const finished = region.evaluate(
            (element) =>
              new Promise<void>((resolve) =>
                element.addEventListener("scrollend", () => resolve(), { once: true }),
              ),
          );
          await region.press("ArrowRight");
          await finished;
          expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
          await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBe(0);
        }
      }
      const a11y = await page.evaluate(async () => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) throw new Error("Missing dialog");
        return (window as unknown as { axe: { run: (element: Element) => Promise<AxeResults> } }).axe.run(
          dialog,
        );
      });
      expect(a11y.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog
        .getByRole("region", { name: "콘솔 오류 관측 내용", exact: true })
        .evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
      await expect(page).toHaveScreenshot(`console-errors-${theme}-${width}.png`, { animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(api.unexpected).toEqual([]);
    });
