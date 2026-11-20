import { expectReadableTableText } from "../fixtures/table-text-readability";
import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

const preferenceKey = "vibe.app.table.v1.observability.requests";
async function open(page: Page) {
  const fixture = await installRequestBulk(page);
  await page.goto("observability/requests");
  await expect(page.getByRole("table", { name: "현재 페이지 요청 목록" })).toBeVisible();
  await expectReadableTableText(page.getByRole("table", { name: "현재 페이지 요청 목록" }));
  return fixture;
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "열 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "표 열 설정" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("읽기 전용 사용자도 표시 열과 순서를 저장하고 새로고침 후 복원한다", async ({ page }) => {
  const fixture = await open(page);
  const dialog = await settings(page);
  await expect(dialog.getByRole("checkbox", { name: /^시각/u })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: /^요청 ID/u })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /^공급자/u }).uncheck();
  await dialog.getByRole("button", { name: "모델 열을 왼쪽으로 이동", exact: true }).click();
  await dialog.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(page.getByRole("button", { name: "열 설정", exact: true })).toBeFocused();
  await expect(page.getByRole("columnheader", { name: /^공급자/u })).toHaveCount(0);
  const headings = await page.getByRole("columnheader").allTextContents();
  expect(headings.indexOf("모델")).toBeLessThan(headings.indexOf("요청 ID"));
  expect(fixture.bulk.reads).toBe(1);
  const saved = await page.evaluate((key) => localStorage.getItem(key) ?? "", preferenceKey);
  expect(Object.keys(JSON.parse(saved) as Record<string, unknown>).sort()).toEqual([
    "columnOrder",
    "columnSizing",
    "columnVisibility",
    "version",
  ]);
  expect(saved).not.toContain("요청-1");
  expect(saved).not.toContain("req_");
  await page.reload();
  await expect(page.getByRole("columnheader", { name: /^공급자/u })).toHaveCount(0);
  await expect(page.getByRole("table")).toBeVisible();
  expect(await page.getByRole("columnheader").allTextContents()).toEqual(headings);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("키보드·마우스로 너비를 바꾸고 기본값으로 되돌린다", async ({ page }) => {
  const fixture = await open(page);
  const handle = page.getByRole("separator", { name: "모델 열 너비 조절", exact: true });
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "80");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Column resize handle not visible");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "128");
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", "128");
  const dialog = await settings(page);
  await dialog.getByRole("button", { name: "기본값으로 초기화", exact: true }).click();
  await dialog.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", "144");
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("열을 숨겨도 선택한 행과 CSV의 운영 항목을 유지한다", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
  const selected = page.getByRole("checkbox", { name: "1번째 요청 선택", exact: true });
  await selected.check();
  const dialog = await settings(page);
  await expect(dialog).toContainText("CSV는 전체 운영 항목을 포함합니다.");
  await dialog.getByRole("checkbox", { name: /^모델/u }).uncheck();
  await dialog.getByRole("button", { name: "설정 완료", exact: true }).click();
  await expect(selected).toBeChecked();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "선택한 요청 CSV", exact: true }).click();
  let csv = "";
  for await (const chunk of await (await download).createReadStream()) csv += String(chunk);
  expect(csv).toContain("공개 모델 1");
  expect(csv).toContain("요청-1");
  expect(csv).not.toContain("요청-2");
  expect(fixture.bulk.reads).toBe(1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("세로로 가려진 마지막 열까지 키보드로 이동해 설정한다", async ({ page }) => {
  const fixture = await open(page);
  const dialog = await settings(page);
  await dialog.getByRole("button", { name: "대화상자 닫기", exact: true }).focus();
  const cost = dialog.getByRole("checkbox", { name: /^비용/u });
  for (let step = 0; step < 32 && !(await cost.evaluate((node) => node === document.activeElement)); step++) {
    await page.keyboard.press("Tab");
  }
  await expect(cost).toBeFocused();
  await expect(cost).toBeInViewport();
  await page.keyboard.press("Space");
  await expect(cost).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "열 설정", exact: true })).toBeFocused();
  await expect(page.getByRole("columnheader", { name: /^비용/u })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("열 설정 중 조회 거부 시 화면을 정리하고 명시 재시도로 복구한다", async ({ page }) => {
  const fixture = await open(page);
  const dialog = await settings(page);
  await dialog.getByRole("checkbox", { name: /^모델/u }).uncheck();
  await page.keyboard.press("Escape");
  fixture.bulk.status = 403;
  // Start the actual refresh, then open the layout dialog while the denied response is pending.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/requests?*", async (route) => {
    await held;
    await route.fallback();
  });
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await settings(page);
  release();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "화면을 불러오지 못했습니다." })).toBeFocused();
  fixture.bulk.status = 200;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /^모델/u })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 열 설정의 한글·포커스·접근성`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await open(page);
      const dialog = await settings(page);
      await dialog.getByRole("checkbox", { name: /^공급자/u }).uncheck();
      await dialog.getByRole("button", { name: "설정 완료", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "대화상자 닫기", exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await page.mouse.move(0, 0);
      await expect(dialog).toHaveScreenshot(`request-columns-${theme}-${width}.png`, {
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "열 설정", exact: true })).toBeFocused();
      // After hiding a column the desktop table can fit without scrolling.
      // Widen a visible column to exercise intentional overflow at both sizes.
      await page.getByRole("separator", { name: "모델 열 너비 조절", exact: true }).press("End");
      const scroll = page.getByLabel("요청 목록 표 영역", { exact: true });
      await expect.poll(() => scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      await scroll.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
