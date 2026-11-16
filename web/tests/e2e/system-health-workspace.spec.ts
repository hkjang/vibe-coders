import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSystemHealthWorkspace } from "../fixtures/system-health-workspace-browser";

test("운영 홈 주소와 새로고침은 현재 두 조회만 갱신한다", async ({ page }) => {
  const fixture = await installSystemHealthWorkspace(page);
  await page.goto("system/health?tab=ops");
  await expect(page.getByText("₩120,000", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "운영 홈", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("list", { name: "장애 후보", exact: true })).toBeVisible();
  const beforeHome = fixture.state.reads["/admin/ops/home"] ?? 0;
  const beforeIncidents = fixture.state.reads["/admin/incidents/candidates"] ?? 0;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect.poll(() => fixture.state.reads["/admin/ops/home"]).toBe(beforeHome + 1);
  expect(fixture.state.reads["/admin/incidents/candidates"]).toBe(beforeIncidents + 1);
  expect(fixture.overviewState.reads["/admin/ops/risk"] ?? 0).toBe(0);
  await expect(page.getByRole("link", { name: /비용.*120,000/ })).toHaveAttribute("href", "/app/finops");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("배포 점검은 요청할 때만 실행하며 새로고침과 탭 복귀로 다시 실행하지 않는다", async ({ page }) => {
  const fixture = await installSystemHealthWorkspace(page);
  await page.goto("system/health?tab=workers");
  await expect(page.getByText("요청 로그 기록", { exact: true })).toBeVisible();
  expect(fixture.state.reads["/admin/ops/preflight"] ?? 0).toBe(0);
  await page.getByRole("button", { name: "점검 실행", exact: true }).click();
  await expect(page.getByRole("table", { name: "배포 사전 점검 결과", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await page.getByRole("tab", { name: "운영 홈", exact: true }).click();
  await expect(page.getByRole("list", { name: "장애 후보", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "백그라운드 작업·배포 점검", exact: true }).click();
  await expect(page.getByText("아직 점검하지 않았습니다.", { exact: true })).toBeVisible();
  expect(fixture.state.reads["/admin/ops/preflight"]).toBe(1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("인덱스 오류 복구 후 SQL을 50개씩 검색하고 키보드로 닫는다", async ({ page }) => {
  const fixture = await installSystemHealthWorkspace(page);
  fixture.state.failIndex = true;
  await page.goto("system/health?tab=indexes");
  await expect(page.getByText("요청 ID: index-workspace-fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("불일치", { exact: true })).toHaveCount(0);
  await expect(page.getByText("눈에 띄는 후보가 없습니다.", { exact: true })).toHaveCount(0);
  fixture.state.failIndex = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  const trigger = page.getByRole("button", { name: "마이그레이션 SQL 보기", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "마이그레이션 SQL", exact: true });
  await expect(dialog.getByRole("listitem")).toHaveCount(50);
  await dialog.getByRole("button", { name: "다음 문장", exact: true }).click();
  await expect(dialog.getByText("CREATE TABLE table_51 (id TEXT);", { exact: true })).toBeVisible();
  await dialog.getByLabel("검색", { exact: true }).fill("table_121");
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "이전 문장", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("운영 신호 권한 거부는 해당 카드만 폐기하고 수동 복구한다", async ({ page }) => {
  const fixture = await installSystemHealthWorkspace(page);
  await page.goto("system/health?tab=ops");
  await expect(page.getByText("₩120,000", { exact: true })).toBeVisible();
  fixture.state.denyHome = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("₩120,000", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "장애 후보", exact: true })).toBeVisible();
  fixture.state.denyHome = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByText("₩120,000", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("자동 갱신은 현재 탭에서만 수행하고 숨겨진 브라우저 탭에서는 멈춘다", async ({ page }) => {
  const fixture = await installSystemHealthWorkspace(page);
  await page.clock.install();
  await page.goto("system/health?tab=ops");
  await expect(page.getByRole("list", { name: "장애 후보", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "자동 새로고침 간격", exact: true }).selectOption("60");
  const before = fixture.state.reads["/admin/ops/home"] ?? 0;
  await page.clock.fastForward(60_100);
  await expect.poll(() => fixture.state.reads["/admin/ops/home"]).toBe(before + 1);
  await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = fixture.state.reads["/admin/ops/home"];
  await page.clock.fastForward(120_100);
  expect(fixture.state.reads["/admin/ops/home"]).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("tab", { name: "백그라운드 작업·배포 점검", exact: true }).click();
  await expect(page.getByText("요청 로그 기록", { exact: true })).toBeVisible();
  await page.clock.fastForward(60_100);
  await expect.poll(() => fixture.state.reads["/admin/ops/workers"]).toBe(2);
  expect(fixture.state.reads["/admin/ops/home"]).toBe(hidden);
  expect(fixture.state.reads["/admin/ops/preflight"] ?? 0).toBe(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const tab of ["status", "ops", "workers", "indexes"])
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390])
      test(`${tab} ${theme} ${width}px 한글·접근성·시각 기준`, async ({ page }) => {
        const fixture = await installSystemHealthWorkspace(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(`system/health?tab=${tab}`);
        const ready =
          tab === "status"
            ? page.getByRole("table", { name: "공급자 현재 운영 점수" })
            : tab === "ops"
              ? page.getByRole("list", { name: "장애 후보" })
              : tab === "workers"
                ? page.getByText("요청 로그 기록", { exact: true })
                : page.getByText("idx_requests_created", { exact: true });
        await expect(ready).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const violations = await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        );
        expect(violations).toEqual([]);
        await expect(page).toHaveScreenshot(`system-${tab}-${theme}-${width}.png`, {
          animations: "disabled",
          fullPage: true,
        });
        expect(fixture.writes).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      });
