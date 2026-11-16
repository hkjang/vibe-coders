import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import {
  installRoutingRuleResourceSearch,
  routingSearchRule,
} from "../fixtures/routing-rule-resource-search-browser";

const direct = `routing/rules?page=2&rule_id=${encodeURIComponent(routingSearchRule.id)}`;
test("라우팅 규칙 검색에서 정확한 상세 주소·새로고침·기존 화면을 연다", async ({ page }) => {
  const fixture = await installRoutingRuleResourceSearch(page);
  await page.goto("system/settings?tab=runtime");
  await page.getByRole("button", { name: "명령 팔레트 열기", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  await palette
    .getByRole("group", { name: "검색할 자원 종류" })
    .getByRole("button", { name: "라우팅 규칙", exact: true })
    .click();
  await palette.getByRole("combobox").fill("정산");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await palette.getByRole("combobox").press("Enter");
  const detail = page.getByRole("dialog", { name: "라우팅 규칙 상세", exact: true });
  await expect(detail.getByText(routingSearchRule.id, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("rule_id")).toBe(routingSearchRule.id);
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["routing_rule"] });
  await page.reload();
  await expect(detail.getByText(routingSearchRule.id, { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: "기존 라우팅 화면" })).toHaveAttribute(
    "href",
    "/admin#/routing",
  );
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  const link = page.getByRole("link", { name: /규칙 상세/ });
  await link.focus();
  await link.press("Enter");
  await expect(detail).toBeVisible();
  await page.goBack();
  await expect(detail).toBeHidden();
  await page.goForward();
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  expect(fixture.state.ids).toContain(routingSearchRule.id);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("상세 오류 재시도와 권한 거부는 목록까지 함께 보호한다", async ({ page }) => {
  const fixture = await installRoutingRuleResourceSearch(page);
  fixture.state.failOnce = true;
  await page.goto(direct);
  const detail = page.getByRole("dialog", { name: "라우팅 규칙 상세", exact: true });
  await expect(detail).toContainText("routing-detail-fixture");
  await detail.getByRole("button", { name: "다시 시도" }).click();
  await expect(detail.getByText(routingSearchRule.id, { exact: true })).toBeVisible();
  fixture.state.deny = true;
  await page.reload();
  await expect(page.getByText("라우팅 규칙 조회 권한을 확인하세요.", { exact: true })).toBeVisible();
  await expect(detail).toBeHidden();
  await expect(page.getByText(routingSearchRule.target_model, { exact: true })).toHaveCount(0);
  fixture.state.deny = false;
  await page.getByRole("button", { name: "권한 다시 확인" }).click();
  await expect(detail.getByText(routingSearchRule.id, { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 라우팅 상세 한글·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installRoutingRuleResourceSearch(page);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto(direct);
      const detail = page.getByRole("dialog", { name: "라우팅 규칙 상세", exact: true });
      await expect(detail.getByText(routingSearchRule.note, { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "닫기", exact: true })).toBeInViewport();
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
      await expect(detail).toHaveScreenshot(`routing-detail-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
