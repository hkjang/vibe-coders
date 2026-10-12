import { expect, type Page } from "@playwright/test";
import { test, account, reason } from "./fixtures/text2sql-emergency";

// Real browser/AuthProvider/ApiClient with synthetic HTTP, not durable state or
// actual SQL execution. Go HTTP lifecycle and audit tests provide separate proof.
const entry = (page: Page, resume = false) =>
  page.getByRole("button", { name: `Text2SQL 처리 ${resume ? "재개" : "중지"} 검토`, exact: true });
const review = (page: Page, resume = false) =>
  page.getByRole("dialog", { name: `Text2SQL 처리 ${resume ? "재개" : "중지"}`, exact: true });
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Ftext2sql");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(entry(page)).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function prepare(page: Page, resume = false) {
  await entry(page, resume).click();
  const dialog = review(page, resume);
  const save = dialog.getByRole("button", { name: resume ? "재개" : "중지", exact: true });
  await expect(save).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "확인 문구", exact: true })
    .fill(`Text2SQL 처리 ${resume ? "재개" : "중지"}`);
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill(reason);
  return save;
}

test("중지와 재개 모두 사유·대상 확인 후 한 번만 전송하고 새로고침으로 상태를 복원한다", async ({
  page,
  emergency,
}) => {
  await login(page);
  expect(emergency.writes).toEqual([]);
  await (await prepare(page)).click();
  await expect(review(page)).toBeHidden();
  await expect(entry(page, true)).toBeEnabled();
  expect(emergency.writes).toHaveLength(1);
  await page.reload();
  await expect(entry(page, true)).toBeEnabled();
  await (await prepare(page, true)).click();
  await expect(review(page, true)).toBeHidden();
  await expect(entry(page)).toBeEnabled();
  expect(emergency.writes).toHaveLength(2);
  expect(emergency.refreshes()).toBe(0);
});

test("401 변경 응답은 자동 재전송하지 않고 상태 재조회만 허용한다", async ({ page, emergency }) => {
  await login(page);
  emergency.denyWrite();
  await (await prepare(page)).click();
  await expect(review(page)).toContainText("처리 결과 확인이 필요합니다.");
  await expect(review(page).getByRole("button", { name: "중지", exact: true })).toBeDisabled();
  await review(page).getByRole("button", { name: "현재 상태만 다시 조회", exact: true }).click();
  await expect(
    review(page).getByRole("button", { name: "현재 상태만 다시 조회", exact: true }),
  ).toBeEnabled();
  expect(emergency.writes).toHaveLength(1);
  expect(emergency.refreshes()).toBe(0);
});

test("현재 상태 조회 실패는 변경을 잠그고 수동 복구만으로 중지하지 않는다", async ({ page, emergency }) => {
  emergency.failRead(true);
  await login(page);
  await expect(page.getByText("현재 Text2SQL 상태를 확인하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(entry(page)).toBeDisabled();
  emergency.failRead(false);
  await page.getByRole("button", { name: "Text2SQL 상태 다시 확인", exact: true }).click();
  await expect(entry(page)).toBeEnabled();
  expect(emergency.writes).toEqual([]);
});

test("검토 중 읽기 전용 전환은 사유를 보존하고 전송을 막는다", async ({ page, emergency }) => {
  await login(page);
  const save = await prepare(page);
  emergency.readonly(true);
  await runtime(page);
  await expect(save).toBeDisabled();
  await expect(review(page).getByRole("textbox", { name: "변경 사유", exact: true })).toHaveValue(reason);
  await review(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(entry(page)).toBeDisabled();
  expect(emergency.writes).toEqual([]);
});

test("390px 다크 확인창은 키보드 초점·줄바꿈·접근성을 유지한다", async ({ page, emergency }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await entry(page).focus();
  await page.keyboard.press("Enter");
  await expect(review(page)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await review(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const close = review(page).getByRole("button", { name: "대화상자 닫기", exact: true });
  const cancel = review(page).getByRole("button", { name: "취소", exact: true });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(review(page).getByRole("textbox", { name: "확인 문구", exact: true })).toBeFocused();
  expect(
    await page.evaluate(async () => {
      const engine = (
        window as Window & { axe?: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      if (!engine) throw new Error("Accessibility engine missing");
      return (await engine.run(document)).violations.map(({ id }) => id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("text2sql-emergency-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(review(page)).toBeHidden();
  await expect(entry(page)).toBeFocused();
  expect(emergency.writes).toEqual([]);
});
