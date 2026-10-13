import { expect, type Page } from "@playwright/test";
import { account, test, type PolicyEditorGateway } from "./fixtures/policy-editor";

const sample = {
  id: "public-alert",
  name: "공개 알림",
  threshold: 1,
  metric: "errors",
  scope: "global",
  scope_value: "*",
  window_seconds: 300,
  enabled: true,
};
async function login(page: Page, gateway: PolicyEditorGateway) {
  gateway.alerts([sample]);
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function bootstrap(page: Page) {
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
for (const mode of ["flag", "status"] as const) {
  test(`알림 ${mode} 읽기 전용은 네 변경 작업을 막는다`, async ({ page, gateway }) => {
    gateway.readonly(mode);
    await login(page, gateway);
    for (const name of ["규칙 추가", "공개 알림 알림 규칙 수정", "공개 알림 알림 규칙 삭제"])
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "공개 알림 사용" })).toBeDisabled();
    expect(gateway.alertOperations).toEqual([]);
  });
}
for (const kind of ["추가", "수정"]) {
  test(`알림 ${kind} 초안을 보존하고 권한 복구 후 명시 저장한다`, async ({ page, gateway }) => {
    await login(page, gateway);
    await page
      .getByRole("button", { name: kind === "추가" ? "규칙 추가" : "공개 알림 알림 규칙 수정", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: `알림 규칙 ${kind}`, exact: true });
    if (kind === "추가")
      await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("공개 새 알림");
    await dialog.getByRole("textbox", { name: "메모", exact: true }).fill("보존할 공개 초안");
    gateway.readonly("flag");
    await bootstrap(page);
    await expect(dialog.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("보존할 공개 초안");
    const submit = dialog.getByRole("button", { name: kind === "추가" ? "규칙 추가" : "저장", exact: true });
    await expect(submit).toBeDisabled();
    await dialog.locator("form").evaluate((node) => (node as HTMLFormElement).requestSubmit());
    expect(gateway.alertOperations).toEqual([]);
    gateway.readonly(false);
    await bootstrap(page);
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(gateway.alertOperations).toHaveLength(1);
    expect(gateway.alertOperations[0]?.body).toMatchObject({ note: "보존할 공개 초안" });
  });
}
test("알림 삭제는 변경된 원본을 거절하고 취소 시 현재 버튼으로 돌아간다", async ({ page, gateway }) => {
  await login(page, gateway);
  await page.getByRole("button", { name: "공개 알림 알림 규칙 삭제" }).click();
  gateway.alerts([{ ...sample, threshold: 7 }]);
  await page
    .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  const dialog = page.getByRole("dialog", { name: "알림 규칙을 삭제할까요?" });
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  expect(gateway.alertOperations).toEqual([]);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 삭제" })).toBeFocused();
});
for (const action of ["수정", "삭제"]) {
  test(`알림 측정값 갱신은 열린 ${action} 검토와 초안을 무효화하지 않는다`, async ({ page, gateway }) => {
    await login(page, gateway);
    await page.getByRole("button", { name: `공개 알림 알림 규칙 ${action}` }).click();
    const dialog = page.getByRole("dialog");
    if (action === "수정")
      await dialog.getByRole("textbox", { name: "메모", exact: true }).fill("보존할 공개 초안");
    gateway.alerts([{ ...sample, last_value: 25, last_fired_at: "2026-10-14T00:00:00Z" }]);
    await page
      .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
      .evaluate((node) => (node as HTMLButtonElement).click());
    // Observe the new table row, not the still-enabled button before refetch settles.
    await expect(page.getByRole("cell", { name: "1 / 25", exact: true, includeHidden: true })).toHaveCount(1);
    if (action === "수정")
      await expect(dialog.getByRole("textbox", { name: "메모", exact: true })).toHaveValue(
        "보존할 공개 초안",
      );
    const submit = dialog.getByRole("button", { name: action === "수정" ? "저장" : "삭제", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(gateway.alertOperations).toHaveLength(1);
    if (action === "수정")
      expect(gateway.alertOperations[0]?.body).toEqual({
        threshold: 1,
        webhook_url: "",
        note: "보존할 공개 초안",
      });
  });
}
test("알림 조회 실패 시 이전 규칙·발화 이력을 숨기고 재조회로 복구한다", async ({ page, gateway }) => {
  await login(page, gateway);
  gateway.failAlertRead(true);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toHaveCount(0);
  await expect(page.getByText("공개 알림 발생", { exact: true })).toHaveCount(0);
  gateway.failAlertRead(false);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toBeVisible();
});
for (const action of ["추가", "수정", "삭제"]) {
  test(`알림 조회 권한 회수는 열린 ${action} 창을 폐기한다`, async ({ page, gateway }) => {
    await login(page, gateway);
    await page
      .getByRole("button", {
        name: action === "추가" ? "규칙 추가" : `공개 알림 알림 규칙 ${action}`,
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    gateway.readable(false);
    await bootstrap(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toHaveCount(0);
    gateway.readable(true);
    await bootstrap(page);
    await expect(page.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(gateway.alertOperations).toEqual([]);
  });
}
test("이전 계정의 알림 변경 완료는 새 계정에 성공 알림을 표시하지 않는다", async ({ page, gateway }) => {
  gateway.holdAlertWrite(1);
  await login(page, gateway);
  await page.getByRole("switch", { name: "공개 알림 사용" }).click();
  await expect.poll(() => gateway.alertOperations.length).toBe(1);
  await expect(page.getByRole("switch", { name: "공개 알림 사용" })).toBeDisabled();
  gateway.owner("public-new-reader");
  await bootstrap(page);
  await expect(page.getByRole("switch", { name: "공개 알림 사용" })).toBeEnabled();
  const response = page.waitForResponse((reply) => reply.request().method() === "PATCH");
  gateway.releaseAlertWrite(1);
  await (await response).finished();
  await expect(page.getByText("알림 규칙을 중지했습니다.", { exact: true })).toHaveCount(0);
  expect(gateway.alertOperations).toHaveLength(1);
});
