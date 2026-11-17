import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";

const csv =
  "\uFEFFcreated_at,kind,actor,action,detail_before,detail_after\n2026-11-18T00:00:00Z,admin_audit,운영자,설정 변경,,공개 예제\n";
async function install(page: Page) {
  const base = await installSettingsWorkspace(page, "viewer");
  base.bootstrap.backend_version = "v0.86.150";
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { delay: false, error: false, denied: false, reads: 0, completed: 0 };
  await page.route("**/admin/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (
      ![
        "/admin/audit-logs.csv",
        "/admin/audit-logs",
        "/admin/audit/auth-events",
        "/admin/system-errors",
      ].includes(path)
    )
      return route.fallback();
    expect(request.method()).toBe("GET");
    if (path === "/admin/system-errors") return route.fulfill({ json: { errors: [] } });
    if (path !== "/admin/audit-logs.csv") {
      if (state.denied) return route.fulfill({ status: 403, json: { error: { code: "permission_denied" } } });
      return route.fulfill({ json: path === "/admin/audit-logs" ? { audit_logs: [] } : { events: [] } });
    }
    state.reads++;
    expect(new URL(request.url()).search).toBe("?limit=5000");
    expect(request.headers()["accept"]).toBe("text/csv");
    expect(request.headers()["x-vibe-route"]).toBe("system.settings");
    if (state.delay) await gate;
    if (state.error)
      await route.fulfill({
        status: 503,
        headers: { "X-Request-ID": "public-audit-download" },
        json: { error: { message: "private-storage-detail", code: "audit_export_failed" } },
      });
    else await route.fulfill({ body: csv, contentType: "text/csv; charset=utf-8" });
    state.completed++;
  });
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  return {
    ...base,
    state,
    release,
    downloads,
    check: () => {
      expect(base.writes).toEqual([]);
      expect(base.unexpected).toEqual([]);
    },
  };
}
const button = (page: Page) => page.getByRole("button", { name: "감사 로그 CSV 다운로드", exact: true });

test("조회 전용 운영자가 한글 CSV를 한 번 내려받고 주소·조회 조건을 유지한다", async ({ page }) => {
  const api = await install(page);
  await page.goto("system/settings?tab=audit&limit=100");
  const event = page.waitForEvent("download");
  await button(page).focus();
  await page.keyboard.press("Enter");
  const download = await event,
    path = await download.path();
  expect(path).not.toBeNull();
  if (!path) throw new Error("다운로드 파일이 생성되지 않았습니다.");
  expect(await readFile(path)).toEqual(Buffer.from(csv));
  await expect(page.getByText("CSV 다운로드 시작", { exact: true })).toBeVisible();
  expect(api.state.reads).toBe(1);
  expect(api.downloads).toHaveLength(1);
  await expect(page).toHaveURL(/tab=audit&limit=100/u);
  api.check();
});

test("키보드로 취소한 요청은 늦게 완료되어도 새 다운로드를 만들지 않는다", async ({ page }) => {
  const api = await install(page);
  api.state.delay = true;
  await page.goto("system/settings?tab=audit");
  await button(page).click();
  await expect(button(page)).toBeDisabled();
  await page.getByRole("button", { name: "다운로드 취소" }).focus();
  await page.keyboard.press("Enter");
  await expect(button(page)).toBeEnabled();
  await expect(button(page)).toBeFocused();
  api.state.delay = false;
  const event = page.waitForEvent("download");
  await button(page).click();
  await event;
  api.release();
  await expect.poll(() => api.state.completed).toBe(2);
  expect(api.downloads).toHaveLength(1);
  api.check();
});

test("다른 설정 탭으로 이동한 뒤 이전 다운로드가 시작되지 않는다", async ({ page }) => {
  const api = await install(page);
  api.state.delay = true;
  await page.goto("system/settings?tab=audit");
  await button(page).click();
  await expect(page.getByText("감사 로그 CSV 준비 중", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "시스템 오류", exact: true }).click();
  api.release();
  await expect.poll(() => api.state.completed).toBe(1);
  await expect(button(page)).toHaveCount(0);
  expect(api.downloads).toEqual([]);
  api.check();
});

test("서버 조회 권한 회수는 진행 중 CSV와 이전 기록을 폐기한다", async ({ page }) => {
  const api = await install(page);
  api.state.delay = true;
  await page.goto("system/settings?tab=audit");
  await button(page).click();
  api.state.denied = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("감사 기록 조회 권한 확인 필요", { exact: true })).toBeVisible();
  api.release();
  await expect.poll(() => api.state.completed).toBe(1);
  expect(api.downloads).toEqual([]);
  api.check();
});

test("실패한 CSV는 안전한 요청 ID를 보여주고 명시적 재시도만 수행한다", async ({ page }) => {
  const api = await install(page);
  api.state.error = true;
  await page.goto("system/settings?tab=audit");
  await button(page).click();
  await expect(page.getByText("요청 ID: public-audit-download")).toBeVisible();
  await expect(page.getByText("private-storage-detail")).toHaveCount(0);
  expect(api.state.reads).toBe(1);
  api.state.error = false;
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await event;
  expect(api.state.reads).toBe(2);
  expect(api.downloads).toHaveLength(1);
  api.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    for (const state of ["pending", "error"] as const)
      test(`감사 CSV ${state} ${theme} ${width}: 진행·오류 안내 시각과 접근성`, async ({ page }) => {
        const api = await install(page);
        api.state.delay = state === "pending";
        api.state.error = state === "error";
        await page.clock.setFixedTime(new Date("2026-11-18T00:00:00Z"));
        await page.setViewportSize({ width, height: 960 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto("system/settings?tab=audit");
        await button(page).click();
        await expect(
          page.getByText(state === "pending" ? "감사 로그 CSV 준비 중" : "요청 ID: public-audit-download", {
            exact: true,
          }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const results = await page.evaluate(async () =>
          (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
        );
        expect(results.violations).toEqual([]);
        await expect(page.locator(".settings-tab-stack")).toHaveScreenshot(
          `audit-csv-${state}-${theme}-${width}.png`,
        );
        if (state === "pending") await page.getByRole("button", { name: "다운로드 취소" }).click();
        api.release();
        api.check();
      });
