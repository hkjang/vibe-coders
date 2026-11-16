import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installText2SqlWorkspace } from "../fixtures/text2sql-workspace-browser";

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`연결 점검 결과: ${theme} ${width}px 상태·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installText2SqlWorkspace(page, {
        status: "warn",
        detail: "연결과 기본 조회만 확인했습니다.",
        driver: "sqlite",
        reachable: true,
        query_ok: true,
        read_only_tx_ok: null,
        statement_timeout_ok: null,
        account_write_restricted: null,
        statement_timeout: "5s",
        probe_timeout: "",
      });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("text2sql?tab=runtime");
      const table = page.getByRole("table", { name: "Text2SQL 실행 DB 연결" });
      const button = table.getByRole("button", { name: "연결 점검", exact: true });
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press("Enter");
      const result = page.getByRole("status").filter({ hasText: "연결 점검 결과 — analytics_db" });
      await expect(result.getByText("확인 안 함", { exact: true })).toHaveCount(2);
      await expect(result.getByText("별도 확인 필요", { exact: true })).toBeVisible();
      await expect(result.getByText("정상", { exact: true })).toHaveCount(2);
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
      await expect(result).toHaveScreenshot(`text2sql-health-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
test("실패 결과의 후속 점검은 미확인이고 재시도는 명시적으로 실행한다", async ({ page }) => {
  const body = { status: "error", detail: "DB에 연결하지 못했습니다.", reachable: false, driver: "postgres" };
  const fixture = await installText2SqlWorkspace(page, body);
  await page.goto("text2sql?tab=runtime");
  const table = page.getByRole("table", { name: "Text2SQL 실행 DB 연결" });
  const button = table.getByRole("button", { name: "연결 점검", exact: true });
  await button.click();
  const result = page.getByRole("alert").filter({ hasText: "연결 점검 결과" });
  await expect(result.getByText("확인 안 함", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  expect(fixture.state.reads["/admin/text2sql/healthcheck"]).toBe(1);
  body.status = "warn";
  body.detail = "연결 복구 확인";
  body.reachable = true;
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "연결 복구 확인" })).toBeVisible();
  expect(fixture.state.reads["/admin/text2sql/healthcheck"]).toBe(2);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
