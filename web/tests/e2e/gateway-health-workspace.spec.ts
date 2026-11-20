import { expectReadableTableText } from "../fixtures/table-text-readability";
import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installGatewayHealthWorkspace } from "../fixtures/gateway-health-workspace-browser";

test("기간 복원과 한글 상태에서 대상 확인·키보드 취소·수동 복구를 연결한다", async ({ page }) => {
  const fixture = await installGatewayHealthWorkspace(page);
  await page.goto("gateway/health?range=7d");
  await expect(page.getByText("세션 해시 분배", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "7일", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const row = page.getByRole("table", { name: "공급자별 회로 차단기 상태" });
  const trigger = row.getByRole("button", { name: "해제", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "회로 차단기 해제", exact: true });
  await expect(dialog).toContainText("사내 분석 공급자");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(fixture.state.writes).toEqual([]);
  await trigger.press("Enter");
  await dialog.getByRole("button", { name: "해제", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.writes).toEqual([{ provider: "사내 분석 공급자" }]);
  expect(fixture.state.windows.every((range) => range === "7d")).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("조회 거부 뒤 기간 변경은 조회를 되살리지 않고 명시적으로 복구한다", async ({ page }) => {
  const fixture = await installGatewayHealthWorkspace(page);
  await page.goto("gateway/health");
  await expect(page.getByRole("table", { name: "공급자별 회로 차단기 상태" })).toBeVisible();
  fixture.state.deny = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("라우팅 상태 조회 권한을 확인하세요.", { exact: true })).toBeVisible();
  await expect(page.getByText("API 연결 가능", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "공급자별 회로 차단기 상태" })).toHaveCount(0);
  const before = fixture.state.reads;
  fixture.state.deny = false;
  await page.getByRole("button", { name: "7일", exact: true }).click();
  await expect(page).toHaveURL(/range=7d/);
  expect(fixture.state.reads).toBe(before);
  await page.getByRole("button", { name: "권한 다시 확인", exact: true }).click();
  await expect(page.getByRole("table", { name: "공급자별 회로 차단기 상태" })).toBeVisible();
  expect(fixture.state.reads).toBe(before + 1);
  expect(fixture.state.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("갱신 실패 시 마지막 상태를 구분하고 새 조회 뒤에 복구 작업을 허용한다", async ({ page }) => {
  const fixture = await installGatewayHealthWorkspace(page);
  await page.goto("gateway/health");
  const table = page.getByRole("table", { name: "공급자별 회로 차단기 상태" });
  await expect(table).toBeVisible();
  fixture.state.failOnce = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("요청 ID: gateway-health-fixture", { exact: true })).toBeVisible();
  await expect(table).toBeVisible();
  await expect(table.getByRole("button", { name: "해제", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "공급자 라우팅 상태 재시도", exact: true }).click();
  await expect(table.getByRole("button", { name: "해제", exact: true })).toBeEnabled();
  expect(fixture.state.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 게이트웨이 상태 한글·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installGatewayHealthWorkspace(page);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("gateway/health?range=7d");
      await expect(page.getByText("세션 해시 분배", { exact: true })).toBeVisible();
      for (const table of await page.getByRole("table").all()) await expectReadableTableText(table);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.locator(".metric-pairs").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth;
        }),
      ).toBe(true);
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`gateway-health-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
      });
      if (width === 390) {
        const tableRegion = page.getByRole("region", { name: "회로 차단기 상태 표", exact: true });
        await expect(tableRegion).toBeVisible();
        expect(await tableRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await tableRegion.focus();
        await tableRegion.press("ArrowRight");
        await expect.poll(() => tableRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await tableRegion.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await page.getByRole("heading", { name: "게이트웨이 상태", exact: true }).click();
        await page.evaluate(() => scrollTo(0, 0));
      }
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
