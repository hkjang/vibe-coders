import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installRequestBulk } from "../fixtures/request-bulk-browser";

const row = (page: Page, index: number) =>
  page.getByRole("checkbox", { name: `${index}번째 요청 선택`, exact: true });
async function open(page: Page) {
  const fixture = await installRequestBulk(page);
  await page.goto("observability/requests");
  await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
  return fixture;
}

test("읽기 전용 화면에서 키보드로 여러 요청을 골라 원래 순서의 CSV를 내려받는다", async ({ page }) => {
  const fixture = await open(page);
  await row(page, 3).focus();
  await page.keyboard.press("Space");
  await row(page, 1).check();
  await expect(page.getByRole("checkbox", { name: "현재 페이지 요청 전체 선택" })).toBeChecked({
    indeterminate: true,
  });
  await expect(page.getByText(/3건 중 2건 선택/u)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "선택한 요청 CSV", exact: true }).click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/^requests-selected-/u);
  let csv = "";
  for await (const chunk of await result.createReadStream()) csv += String(chunk);
  expect(csv).toContain("요청-1");
  expect(csv).toContain("요청-3");
  expect(csv).not.toContain("요청-2");
  expect(csv.indexOf("요청-1")).toBeLessThan(csv.indexOf("요청-3"));
  expect(csv).toContain("0.0004");
  expect(csv).toContain("'=1+1");
  expect(fixture.bulk.reads).toBe(1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("전체 선택과 해제를 지원하고 서버 페이지 왕복에서 선택을 비운다", async ({ page }) => {
  const fixture = await open(page);
  const all = page.getByRole("checkbox", { name: "현재 페이지 요청 전체 선택" });
  await all.check();
  await expect(page.getByText(/3건 중 3건 선택/u)).toBeVisible();
  await page.getByRole("button", { name: "선택 해제", exact: true }).click();
  await expect(all).not.toBeChecked();
  await row(page, 1).check();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByText(/1건 중 0건 선택/u)).toBeVisible();
  await expect(row(page, 1)).not.toBeChecked();
  await page.getByRole("button", { name: "이전", exact: true }).click();
  await expect(page.getByText(/3건 중 0건 선택/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "선택한 요청 CSV", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("조회 거부 시 행·선택·CSV를 지우고 명시 재시도로만 다시 연다", async ({ page }) => {
  await page.clock.install();
  const fixture = await open(page);
  await row(page, 1).check();
  fixture.bulk.status = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(
    page.getByText("현재 요청 목록의 조회가 거부되었습니다. 권한을 확인한 뒤 다시 조회하세요."),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "현재 목록 CSV", exact: true })).toHaveCount(0);
  const reads = fixture.bulk.reads;
  fixture.bulk.status = 200;
  await page.evaluate(() => {
    dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(61_000);
  expect(fixture.bulk.reads).toBe(reads);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(row(page, 1)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "선택한 요청 CSV", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("선택 중 자동 갱신을 멈추고 선택을 마치면 설정한 주기로 다시 갱신한다", async ({ page }) => {
  await page.clock.install();
  const fixture = await open(page);
  await page.getByLabel("자동 새로고침 간격").selectOption("60");
  await row(page, 1).check();
  const reads = fixture.bulk.reads;
  await page.clock.runFor(61_000);
  expect(fixture.bulk.reads).toBe(reads);
  await expect(row(page, 1)).toBeChecked();
  await page.getByRole("button", { name: "선택 마치기", exact: true }).click();
  await page.clock.runFor(61_000);
  await expect.poll(() => fixture.bulk.reads).toBeGreaterThan(reads);
  await page.getByRole("button", { name: "여러 요청 선택", exact: true }).click();
  await expect(row(page, 1)).not.toBeChecked();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("일시 오류의 이전 행과 새 빈 응답을 구분하고 CSV를 잠근다", async ({ page }) => {
  const fixture = await open(page);
  await row(page, 1).check();
  fixture.bulk.status = 503;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
  await expect(row(page, 1)).toBeDisabled();
  await expect(page.getByRole("button", { name: "현재 목록 CSV", exact: true })).toBeDisabled();
  fixture.bulk.status = 200;
  fixture.bulk.empty = true;
  await page.getByRole("button", { name: "재시도", exact: true }).click();
  await expect(page.getByText(/조건에 맞는 요청이 없습니다/u)).toBeVisible();
  await expect(page.getByText(/0건 중 0건 선택/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "선택한 요청 CSV", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 요청 선택의 한글·접근성·시각 기준`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await open(page);
      await row(page, 1).check();
      const table = page.locator(".request-page .data-table-shell");
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
      await expect(table).toHaveScreenshot(`request-bulk-${theme}-${width}.png`, { animations: "disabled" });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
