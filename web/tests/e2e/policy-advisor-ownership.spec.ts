import { expect, type Page } from "@playwright/test";
import { account, policy, test } from "./fixtures/policy-editor";

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "정책 적용 비율을 상향할까요?", exact: true });
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dadvisor");
  await expect(page.getByText("백엔드 v0.86.31", { exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 적용 비율 상향` })).toBeEnabled();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
  await page.getByRole("button", { name: `${policy.name} 적용 비율 상향` }).click();
}
async function bootstrap(page: Page) {
  const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("정책 추천은 검토한 현재 원본의 적용 비율만 한 번 변경한다", async ({ page, gateway }) => {
  await login(page);
  await dialog(page).getByRole("button", { name: "상향", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(gateway.saves).toHaveLength(1);
  expect(gateway.saves[0]).toMatchObject({ id: policy.id, enabled: false, rollout_percent: 50 });
  expect(gateway.saves[0]?.rules).toEqual(
    policy.rules?.map(({ id, name, enabled, priority, conditions, actions }) => ({
      id,
      name,
      enabled,
      priority,
      conditions,
      actions,
    })),
  );
});

test("기존 추천 링크와 독립 주소 새로고침은 같은 화면과 기간을 유지한다", async ({ page, gateway }) => {
  await login(page);
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/governance\/policies\/advisor\?tab=advisor/u);
  await page.getByLabel("정책 단계 적용 집계 기간", { exact: true }).selectOption("14");
  await page.reload();
  await expect(page.getByRole("tab", { name: "정책 추천", selected: true })).toBeVisible();
  await expect(page.getByLabel("정책 단계 적용 집계 기간", { exact: true })).toHaveValue("14");
  await page.getByRole("tab", { name: "안전 정책", exact: true }).click();
  await expect(page.getByRole("button", { name: `${policy.name} 사용`, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "정책 추천", exact: true }).click();
  await expect(page.getByLabel("정책 단계 적용 집계 기간", { exact: true })).toHaveValue("14");
  const advisor = page.getByRole("tab", { name: "정책 추천", selected: true });
  await expect(advisor).toBeFocused();
  await advisor.press("Home");
  await expect(page.getByRole("tab", { name: "안전 정책", selected: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(advisor).toBeFocused();
  expect(gateway.saves).toEqual([]);
});

for (const boundary of ["changed", "readonly"] as const) {
  test(`정책 추천의 ${boundary} 변경은 확인 버튼 조작으로도 우회하지 못한다`, async ({ page, gateway }) => {
    await login(page);
    if (boundary === "readonly") {
      gateway.readonly("flag");
      await bootstrap(page);
    } else {
      gateway.policies([{ ...policy, description: "다른 운영자의 변경" }]);
      await page
        .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
    }
    const confirm = dialog(page).getByRole("button", { name: "상향", exact: true });
    await expect(confirm).toBeDisabled();
    await confirm.evaluate((button) => {
      (button as HTMLButtonElement).disabled = false;
      (button as HTMLButtonElement).click();
    });
    expect(gateway.saves).toEqual([]);
  });
}

test("추천 탭의 새 계정은 이전 검토 대신 자신의 정책 조회를 기다린다", async ({ page, gateway }) => {
  await login(page);
  const next = gateway.reads() + 1;
  gateway.holdRead(next);
  gateway.policies([{ ...policy, name: "새 계정 정책" }]);
  gateway.owner("public-reader-b");
  await bootstrap(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${policy.name} 적용 비율 상향` })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "새 계정 정책 적용 비율 상향" });
  await expect(trigger).toBeDisabled();
  await expect.poll(() => gateway.reads()).toBe(next);
  gateway.releaseRead(next);
  await expect(trigger).toBeEnabled();
  expect(gateway.saves).toEqual([]);
});
