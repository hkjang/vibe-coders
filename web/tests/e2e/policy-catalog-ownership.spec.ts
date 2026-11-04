import { expect, type Page } from "@playwright/test";
import { account, policy, test } from "./fixtures/policy-editor";

async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dsafety");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}

test("정책 목록 재조회 실패 후 이전 규칙과 사용 버튼을 표시하지 않는다", async ({ page, gateway }) => {
  await login(page);
  gateway.failRead(gateway.reads() + 1);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${policy.name} 초안 편집`, exact: true })).toHaveCount(0);
  await expect(page.getByText("public-model", { exact: false })).toHaveCount(0);
  expect(gateway.saves).toEqual([]);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toBeVisible();
});

test("계정 전환 시 이전 확인창과 목록은 사라지고 새 계정 조회를 기다린다", async ({ page, gateway }) => {
  await login(page);
  await page.getByRole("button", { name: `${policy.name} 사용`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "정책을 사용할까요?" })).toBeVisible();
  const sequence = gateway.reads() + 1;
  gateway.holdRead(sequence);
  gateway.policies([{ ...policy, name: "새 계정의 정책" }]);
  gateway.owner("policy-reader-b");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await expect(page.getByRole("dialog", { name: "정책을 사용할까요?" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toHaveCount(0);
  await expect.poll(() => gateway.reads()).toBe(sequence);
  gateway.releaseRead(sequence);
  await expect(page.getByRole("button", { name: "새 계정의 정책 사용", exact: true })).toBeVisible();
  expect(gateway.saves).toEqual([]);
});

test("확인 이후 목록의 원본이 바뀌면 사용 전송을 차단한다", async ({ page, gateway }) => {
  await login(page);
  await page.getByRole("button", { name: `${policy.name} 사용`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "정책을 사용할까요?" });
  gateway.policies([{ ...policy, description: "다른 운영자가 수정한 원본" }]);
  // A background page refresh is admitted without closing the current review.
  await page
    .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  const confirm = dialog.getByRole("button", { name: "사용", exact: true });
  await expect(confirm).toBeDisabled();
  await confirm.evaluate((button) => {
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).click();
  });
  expect(gateway.saves).toEqual([]);
});
