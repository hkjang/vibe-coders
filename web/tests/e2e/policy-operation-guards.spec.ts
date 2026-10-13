import { expect, type Page } from "@playwright/test";
import { account, test, type PolicyEditorGateway } from "./fixtures/policy-editor";

const sample = { id: "public-case", name: "공개 회귀 시나리오", expect: "allow" };
async function login(page: Page, gateway: PolicyEditorGateway) {
  gateway.regression([sample]);
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: `${sample.name} 시나리오 삭제` })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function bootstrap(page: Page) {
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용은 정책 생성·시나리오 생성·실행·삭제를 잠근다`, async ({ page, gateway }) => {
    gateway.readonly(mode);
    await login(page, gateway);
    for (const name of ["정책 추가", "시나리오 추가", "전체 회귀 실행", `${sample.name} 시나리오 삭제`])
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    expect(gateway.saves).toEqual([]);
    expect(gateway.operations).toEqual([]);
  });
}
for (const form of [
  { trigger: "정책 추가", title: "AI 정책 추가", label: "정책 이름", submit: "정책 저장", policy: true },
  {
    trigger: "시나리오 추가",
    title: "회귀 시나리오 추가",
    label: "시나리오 이름",
    submit: "시나리오 저장",
    policy: false,
  },
]) {
  test(`${form.trigger} 초안은 권한 전환 중 유지하고 명시 저장만 허용한다`, async ({ page, gateway }) => {
    await login(page, gateway);
    await page.getByRole("button", { name: form.trigger, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: form.title, exact: true });
    await dialog.getByRole("textbox", { name: form.label, exact: true }).fill("보존할 공개 입력");
    gateway.readonly("flag");
    await bootstrap(page);
    await expect(dialog.getByRole("textbox", { name: form.label, exact: true })).toHaveValue(
      "보존할 공개 입력",
    );
    await expect(dialog.getByRole("button", { name: form.submit, exact: true })).toBeDisabled();
    await dialog.locator("form").evaluate((node) => (node as HTMLFormElement).requestSubmit());
    expect(gateway.saves).toEqual([]);
    expect(gateway.operations).toEqual([]);
    gateway.readonly(false);
    await bootstrap(page);
    await dialog.getByRole("button", { name: form.submit, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(form.policy ? gateway.saves : gateway.operations).toHaveLength(1);
  });
}
test("열린 삭제 검토는 조회한 시나리오가 바뀌면 잠긴다", async ({ page, gateway }) => {
  await login(page, gateway);
  await page.getByRole("button", { name: `${sample.name} 시나리오 삭제` }).click();
  gateway.regression([{ ...sample, expect: "block" }]);
  await page
    .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  const dialog = page.getByRole("dialog", { name: "회귀 시나리오를 삭제할까요?" });
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  expect(gateway.operations).toEqual([]);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: `${sample.name} 시나리오 삭제` })).toBeFocused();
});
test("조회 권한이 없으면 열린 삭제 확인창에서 시나리오 이름을 제거한다", async ({ page, gateway }) => {
  await login(page, gateway);
  await page.getByRole("button", { name: `${sample.name} 시나리오 삭제` }).click();
  gateway.readable(false);
  await bootstrap(page);
  const dialog = page.getByRole("dialog", { name: "회귀 시나리오를 삭제할까요?" });
  await expect(dialog).not.toContainText(sample.name);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  expect(gateway.operations).toEqual([]);
  gateway.readable(true);
  await bootstrap(page);
  await expect(dialog).toContainText(sample.name);
  expect(gateway.operations).toEqual([]);
});
test("이전 계정의 늦은 회귀 결과는 새 계정에 나타나지 않는다", async ({ page, gateway }) => {
  gateway.holdRun(1);
  await login(page, gateway);
  await page.getByRole("button", { name: "전체 회귀 실행", exact: true }).click();
  await expect.poll(() => gateway.operations.length).toBe(1);
  await expect(page.getByRole("button", { name: "전체 회귀 실행", exact: true })).toBeDisabled();
  gateway.owner("public-new-reader");
  await bootstrap(page);
  await expect(page.getByRole("button", { name: "전체 회귀 실행", exact: true })).toBeEnabled();
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/policies/regression/run",
  );
  gateway.releaseRun(1);
  await (await reply).finished();
  await expect(page.getByText(/회귀 결과 —/u)).toHaveCount(0);
  await expect(page.getByText(/회귀 실행 완료 —/u)).toHaveCount(0);
  expect(gateway.operations).toHaveLength(1);
});
