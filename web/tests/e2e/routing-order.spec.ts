import { expect, type Page, type Locator } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test, firstEmail, routingUrl } from "./fixtures/routing-order";

const dialogFor = (page: Page) => page.getByRole("dialog", { name: "규칙 순서 변경", exact: true });
async function login(page: Page, open = true) {
  await page.goto(`login?return_to=${encodeURIComponent(routingUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const trigger = page.getByRole("button", { name: "규칙 순서 변경", exact: true });
  await expect(trigger).toBeEnabled();
  if (!open) return dialogFor(page);
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("button", { name: "2번째 규칙 위로" })).toBeEnabled();
  return dialog;
}

test("순서·생성 편집기 코드는 각 버튼을 선택한 뒤에만 로드한다", async ({ page, ordering }) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  await login(page, false);
  expect(scripts.some((path) => /Routing(OrderDialog|RuleCreateDialog)-/u.test(path))).toBe(false);
  await page.getByRole("button", { name: "규칙 순서 변경", exact: true }).click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("button", { name: "순서 변경 비교" })).toBeVisible();
  expect(scripts.some((path) => /RoutingOrderDialog-/u.test(path))).toBe(true);
  expect(scripts.some((path) => /RoutingRuleCreateDialog-/u.test(path))).toBe(false);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "규칙 추가", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "라우팅 규칙 추가", exact: true })).toBeVisible();
  expect(scripts.some((path) => /RoutingRuleCreateDialog-/u.test(path))).toBe(true);
  expect(ordering.saves).toEqual([]);
});
async function preview(dialog: Locator) {
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("우선순위 검토 완료");
  await dialog.getByRole("textbox", { name: "검증할 모델명", exact: true }).fill("public-request");
  await dialog.getByRole("button", { name: "순서 변경 비교" }).click();
  await expect(dialog.getByRole("region", { name: "변경 후 선택" })).toBeVisible();
}

test("키보드로 순서를 바꾸고 검토한 전체 우선순위를 한 번 저장한다", async ({ page, ordering }) => {
  const dialog = await login(page);
  await dialog.getByRole("button", { name: "2번째 규칙 위로" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "1번째 규칙 아래로" })).toBeFocused();
  await preview(dialog);
  const save = dialog.getByRole("button", { name: "검토한 순서 저장" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await save.dblclick();
  await expect(dialog).toContainText("라우팅 규칙 순서와 감사 기록을 저장했습니다.");
  expect(ordering.saves).toHaveLength(1);
  expect(ordering.saves[0]?.order).toEqual(["route_public_b", "route_public_a"]);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("button", { name: "규칙 순서 변경", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("table").getByRole("row").nth(1)).toContainText("public-model-b");
});
test("끌어서 순서를 바꾸고 응답이 끊기면 재저장하지 않는다", async ({ page, ordering }) => {
  const dialog = await login(page);
  const rows = dialog.getByRole("listitem");
  await rows.nth(1).dragTo(rows.nth(0));
  await expect(rows.first()).toContainText("public-model-b");
  await preview(dialog);
  await dialog.getByRole("checkbox").check();
  ordering.loseResponse();
  await dialog.getByRole("button", { name: "검토한 순서 저장" }).click();
  await expect(dialog).toContainText("이미 반영되었을 수 있어 이 창에서 다시 저장하지 않습니다.");
  await expect(dialog.getByRole("button", { name: "검토한 순서 저장" })).toBeDisabled();
  expect(ordering.saves).toHaveLength(1);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`순서 비교 접근성·시각 기준 ${theme}-${width}`, async ({ page, ordering }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const dialog = await login(page);
      await dialog.getByRole("button", { name: "2번째 규칙 위로" }).click();
      await preview(dialog);
      await dialog.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (target: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      expect(violations).toEqual([]);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`routing-order-${theme}-${width}.png`, { fullPage: true });
      await dialog.getByRole("checkbox").check();
      await expect(dialog.getByRole("button", { name: "검토한 순서 저장" })).toBeEnabled();
      await expect(page).toHaveScreenshot(`routing-order-review-${theme}-${width}.png`, { fullPage: true });
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(ordering.saves).toEqual([]);
    });
  }
