import { expect, test, type Page, type Request } from "@playwright/test";
import process from "node:process";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";

const summary = {
  enabled: true,
  days: 7,
  from: "2026-11-13T00:00:00Z",
  to: "2026-11-20T00:00:00Z",
  retention_days: 30,
  visit_limit: 100_000,
  load_metrics_available: true,
  load_limit_ms: 120_000,
  version_limit: 20,
  other_version_visits: 0,
  features: [
    {
      feature_id: "system.settings",
      visits: 20,
      legacy_opens: 2,
      load_samples: 8,
      load_total_ms: 2000,
      load_max_ms: 600,
    },
    {
      feature_id: "gateway.providers",
      visits: 5,
      legacy_opens: 0,
      load_samples: 0,
      load_total_ms: 0,
      load_max_ms: 0,
    },
  ],
  versions: [
    { ui_version: "v0.86.179", visits: 20, load_samples: 8, load_total_ms: 2000, load_max_ms: 600 },
    { ui_version: "", visits: 5, load_samples: 0, load_total_ms: 0, load_max_ms: 0 },
  ],
};

async function installUsage(page: Page, backend = "v0.86.179") {
  const state = await installSettingsWorkspace(page);
  state.bootstrap.backend_version = backend;
  state.bootstrap.ui.telemetry_enabled = true;
  const events: Request[] = [];
  await page.route("**/admin/ui-telemetry/events", (route) => {
    events.push(route.request());
    return route.fulfill({ status: 204 });
  });
  await page.route("**/admin/ui-telemetry/summary*", (route) =>
    route.fulfill({
      json: { ...summary, days: Number(new URL(route.request().url()).searchParams.get("days") ?? 7) },
    }),
  );
  return { ...state, events };
}

test("실제 Go에 첫 표시 시간과 릴리즈 버전을 기록하고 합계로 읽는다", async ({ page, request }) => {
  test.skip(process.env.APP_UI_LOAD_LIVE !== "1", "격리된 Go embed 실행에서 검증합니다.");
  const expectedVersion = process.env.APP_UI_LOAD_VERSION ?? "v0.86.179";
  const sent: Request[] = [];
  page.on("request", (event) => {
    if (new URL(event.url()).pathname === "/admin/ui-telemetry/events") sent.push(event);
  });
  await page.goto("system/settings?tab=console");
  await expect(page.getByRole("heading", { name: "첫 화면 표시 시간", exact: true })).toBeVisible();
  await expect.poll(() => sent.some((event) => event.postDataJSON().event === "page_load")).toBe(true);
  const load = sent.find((event) => event.postDataJSON().event === "page_load");
  expect(load?.headers()["x-vibe-ui-version"]).toBe(expectedVersion);
  await expect
    .poll(async () => {
      const response = await request.get("/admin/ui-telemetry/summary");
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as typeof summary;
      return body.versions.find((row) => row.ui_version === expectedVersion)?.load_samples ?? 0;
    })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "관측 결과 새로고침", exact: true }).click();
  await expect(page.getByRole("region", { name: "UI 버전별 사용 관측", exact: true })).toContainText(
    expectedVersion,
  );
});

test("지연된 화면 코드를 기다린 시간을 포함하고 조회 조건은 전송하지 않는다", async ({ page }) => {
  const api = await installUsage(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  await page.route(/\/app\/assets\/SystemSettingsPage-[^/]+\.js$/, async (route) => {
    blocked = true;
    await pending;
    await route.continue();
  });
  await page.goto("system/settings?tab=console&q=private-search", { waitUntil: "commit" });
  await expect.poll(() => blocked).toBe(true);
  const beforeRelease = await page.evaluate(() => performance.now());
  expect(api.events).toHaveLength(0);
  release();
  await expect
    .poll(() => api.events.filter((event) => event.postDataJSON().event === "page_load").length)
    .toBe(1);
  const visit = api.events.find((event) => event.postDataJSON().event === "visit");
  const load = api.events.find((event) => event.postDataJSON().event === "page_load");
  expect(load?.postDataJSON()).toMatchObject({
    feature_id: "system.settings",
    visit_id: visit?.postDataJSON().visit_id,
    event: "page_load",
  });
  expect(load?.postDataJSON().load_ms).toBeGreaterThanOrEqual(Math.floor(beforeRelease));
  await page.getByLabel("조회 기간", { exact: true }).selectOption("30");
  await expect(page.getByLabel("조회 기간", { exact: true })).toHaveValue("30");
  await expect(page.getByRole("heading", { name: "첫 화면 표시 시간", exact: true })).toBeVisible();
  expect(api.events).toHaveLength(2);
  for (const event of api.events) {
    expect(event.headers()["referer"]).toBeUndefined();
    expect(event.postData()).not.toMatch(/private|prompt|email|user|team|\/app\//);
    expect(Object.keys(event.postDataJSON()).sort()).toEqual(
      event === load ? ["event", "feature_id", "load_ms", "visit_id"] : ["event", "feature_id", "visit_id"],
    );
  }
  expect(api.unexpected).toEqual([]);
});

test("구버전 서버에는 기존 방문 이벤트만 전송한다", async ({ page }) => {
  const api = await installUsage(page, "v0.86.178");
  await page.goto("system/settings?tab=console");
  await expect(page.getByRole("heading", { name: "신규 콘솔 사용 관측", exact: true })).toBeVisible();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect.poll(() => api.events.length).toBe(1);
  expect(api.events[0]?.postDataJSON().event).toBe("visit");
});

test("기능 전환 편집 코드는 편집과 상세 주소에서만 불러오고 포커스를 복원한다", async ({ page }) => {
  const api = await installUsage(page);
  api.settings.push({
    key: "ui.app.feature.system.settings.status",
    category: "ui.app.features",
    type: "string",
    description: "시스템 설정 전환 상태",
    value: "preview",
    source: "admin",
    version: 1,
    can_write: true,
    is_secret: false,
    read_only: false,
    restart_required: false,
  });
  const editorRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/ConsoleFeatureDialog-[^/]+\.js$/.test(request.url())) editorRequests.push(request.url());
  });
  await page.goto("system/settings?tab=console");
  const edit = page.getByRole("button", { name: "시스템 설정 전환 설정 편집", exact: true });
  await expect(edit).toBeVisible();
  expect(editorRequests).toEqual([]);
  await edit.focus();
  await edit.press("Enter");
  await expect(page.getByRole("dialog", { name: "시스템 설정 전환 설정", exact: true })).toBeVisible();
  expect(editorRequests).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await page.goto("system/settings?tab=console&setting=ui.app.feature.system.settings.status");
  await expect(page.getByRole("dialog", { name: "시스템 설정 전환 설정", exact: true })).toBeVisible();
  expect(api.writes).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`측정 범위와 한글 버전 통계를 표 경계 안에서 읽는다 ${width}px ${theme}`, async ({ page }) => {
      const api = await installUsage(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date("2026-11-20T00:00:00Z"));
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("system/settings?tab=console");
      const panel = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "신규 콘솔 사용 관측", exact: true }) });
      await expect(panel.getByRole("heading", { name: "첫 화면 표시 시간", exact: true })).toBeVisible();
      await expect(panel.getByText(/측정된 방문 8 \/ 25회/)).toContainText("평균 250 ms · 최대 600 ms");
      for (const name of ["기능별 사용 관측", "UI 버전별 사용 관측"]) {
        const region = panel.getByRole("region", { name, exact: true });
        await expectCellBoundaries(region.getByRole("table"));
        await region.focus();
        await expect(region).toBeFocused();
        if (width === 390) {
          const scrollFinished = region.evaluate(
            (element) =>
              new Promise<void>((resolve) => {
                element.addEventListener("scrollend", () => resolve(), { once: true });
              }),
          );
          await region.press("ArrowRight");
          await scrollFinished;
          await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate((element) => {
            element.scrollTo({ left: 0, behavior: "instant" });
          });
          await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBe(0);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const a11y = await page.evaluate(async () => {
        const main = document.querySelector("main");
        if (!main) throw new Error("Main content is missing");
        return (window as unknown as { axe: { run: (element: Element) => Promise<AxeResults> } }).axe.run(
          main,
        );
      });
      expect(a11y.violations).toEqual([]);
      // Full-page capture keeps the sticky header in its actual document context.
      // An element taller than the viewport otherwise captures the header over it.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page).toHaveScreenshot(`console-load-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
      });
      expect(api.unexpected).toEqual([]);
    });
  }
