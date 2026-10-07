import { expect, type Locator, type Page } from "@playwright/test";
import { test, firstEmail, learningUrl, learningModel, listPath } from "./fixtures/routing-learning-create";

const dialogFor = (page: Page) =>
  page.getByRole("dialog", { name: "학습 추천으로 규칙 만들기", exact: true });
const finalFor = (dialog: Locator) => dialog.getByRole("button", { name: "규칙 만들기", exact: true });
const consentFor = (dialog: Locator) =>
  dialog.getByRole("checkbox", {
    name: "작업 유형과 관계없이 해당 복잡도 범위에 적용됨을 확인했습니다",
    exact: true,
  });
const queueFor = (page: Page) =>
  page.getByRole("table", { name: "도메인 라우팅 검토 큐", exact: true, includeHidden: true });
const expectedInput = {
  match_pattern: "*",
  target_model: learningModel,
  target_provider: "",
  min_complexity: 0,
  max_complexity: 33,
  priority: 100,
  note: "학습 추천 적용 (code/low)",
  enabled: true,
};

async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(learningUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("table", { name: "학습된 모델 추천", exact: true })).toBeVisible();
  // The neighboring review owner must actually mount for this regression.
  await expect(queueFor(page)).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page) {
  await page.getByRole("button", { name: /추천을 규칙으로 적용/u }).click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("heading", { name: "생성 내용 검토", exact: true })).toBeVisible();
  await consentFor(dialog).check();
  await expect(finalFor(dialog)).toBeEnabled();
  const original = await dialog.elementHandle();
  if (!original) throw new Error("학습 추천 검토창이 없습니다.");
  return {
    dialog,
    async expectOriginal() {
      await expect(dialog).toBeVisible();
      expect(await original.evaluate((element) => element.isConnected)).toBe(true);
      expect(await dialog.evaluate((element, before) => element === before, original)).toBe(true);
    },
  };
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("검토 큐가 있는 학습창은 쓰기 회수·복구 후에도 유지되며 새 검토와 동의 뒤 한 번 생성한다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  gateway.setRawPromptView(true);
  await login(page);
  expect(learner.calls.some((call) => call.path === "/admin/routing/domain-review")).toBe(true);
  const opened = await open(page);
  gateway.setWrite(false);
  await refreshIdentity(page);
  await opened.expectOriginal();
  await expect(finalFor(opened.dialog)).toBeDisabled();
  await expect(consentFor(opened.dialog)).not.toBeChecked();
  expect(creator.calls).toEqual([]);

  gateway.setWrite(true);
  await refreshIdentity(page);
  await opened.expectOriginal();
  await expect(finalFor(opened.dialog)).toBeDisabled();
  await opened.dialog.getByRole("button", { name: "생성 내용 다시 검토", exact: true }).click();
  await expect(consentFor(opened.dialog)).not.toBeChecked();
  await expect(finalFor(opened.dialog)).toBeDisabled();
  expect(creator.calls).toEqual([]);
  await consentFor(opened.dialog).check();
  await finalFor(opened.dialog).click();
  await expect(opened.dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(creator.calls).toEqual([{ method: "POST", path: listPath, body: expectedInput }]);
});

test("원문 조회 회수로 검토 큐가 사라져도 학습창의 동의와 정상 생성은 유지한다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  gateway.setRawPromptView(true);
  await login(page);
  expect(learner.calls.some((call) => call.path === "/admin/routing/domain-review")).toBe(true);
  const opened = await open(page);
  gateway.setRawPromptView(false);
  await refreshIdentity(page);
  await expect(queueFor(page)).toHaveCount(0);
  await opened.expectOriginal();
  await expect(consentFor(opened.dialog)).toBeChecked();
  await expect(finalFor(opened.dialog)).toBeEnabled();
  expect(creator.calls).toEqual([]);
  await finalFor(opened.dialog).click();
  await expect(opened.dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(creator.calls).toEqual([{ method: "POST", path: listPath, body: expectedInput }]);
});

test("검토 큐의 쓰기 권한 변경 뒤 도착한 정상 학습 생성 ACK는 같은 창에서 확인한다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  gateway.setRawPromptView(true);
  await login(page);
  expect(learner.calls.some((call) => call.path === "/admin/routing/domain-review")).toBe(true);
  const opened = await open(page);
  creator.hold();
  await finalFor(opened.dialog).click();
  await expect.poll(() => creator.calls.length).toBe(1);
  gateway.setWrite(false);
  await refreshIdentity(page);
  await opened.expectOriginal();
  await expect(opened.dialog.getByText("현재 규칙을 만들 수 없습니다.", { exact: true })).toBeVisible();
  await expect(finalFor(opened.dialog)).toBeDisabled();
  creator.release();
  await expect(opened.dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  await expect(opened.dialog.getByRole("button", { name: "목록 다시 조회", exact: true })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await opened.expectOriginal();
  expect(creator.calls).toEqual([{ method: "POST", path: listPath, body: expectedInput }]);
});
