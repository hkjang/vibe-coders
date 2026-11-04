import { expect, type Page } from "@playwright/test";
import { test, account, policy } from "./fixtures/policy-editor";

const detail = (page: Page) => page.getByRole("dialog", { name: "정책 상세", exact: true });
async function login(page: Page, selected = false) {
  const target = selected
    ? `/app/governance/policies/detail?tab=safety&policy=${policy.id}`
    : "/app/governance/policies?tab=safety";
  await page.goto(`login?return_to=${encodeURIComponent(target)}`);
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  if (selected) await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  else await expect(page.getByRole("heading", { name: "정책 및 거버넌스", exact: true })).toBeVisible();
}

test("정책 이름 검색에서 읽기 전용 상세를 열고 새로고침과 닫기 후 포커스를 유지한다", async ({
  page,
  gateway,
}) => {
  gateway.writable(false);
  const requests: unknown[] = [];
  await page.route("**/admin/resource-search", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        request_id: "policy-search-request",
        groups: [
          {
            kind: "policy",
            status: "ok",
            limited: false,
            items: [{ kind: "policy", id: policy.id, title: policy.name }],
          },
        ],
      },
    });
  });
  await login(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("combobox").fill("공개");
  await expect(palette.getByRole("option")).toBeVisible();
  expect(requests).toEqual([{ query: "공개", kinds: ["policy"] }]);
  await page.keyboard.press("Enter");
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`policy=${policy.id}`));
  await page.reload();
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  await expect(detail(page)).toContainText("25%");
  await expect(detail(page)).toContainText("2개");
  await expect(detail(page)).not.toContainText(policy.description ?? "");
  await page.keyboard.press("Escape");
  await expect(detail(page)).toBeHidden();
  await expect(page).not.toHaveURL(/policy=/u);
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.saves).toEqual([]);
});

test("정책 상세 재조회 실패는 이전 요약을 숨기고 키보드 재시도로 복구한다", async ({ page, gateway }) => {
  await login(page, true);
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  gateway.failRead(gateway.reads() + 1);
  const retry = detail(page).getByRole("button", { name: "정책 다시 조회" });
  await retry.click();
  await expect(detail(page).getByRole("alert")).toBeVisible();
  await expect(detail(page).getByRole("heading", { name: policy.name })).toHaveCount(0);
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  expect(gateway.saves).toEqual([]);
});

test("조회 중 삭제된 정책은 오래된 요약 대신 찾을 수 없음 안내를 제공한다", async ({ page, gateway }) => {
  await login(page, true);
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  gateway.policies([]);
  await detail(page).getByRole("button", { name: "정책 다시 조회" }).click();
  await expect(detail(page).getByText("정책을 찾을 수 없습니다.")).toBeVisible();
  await expect(detail(page).getByRole("heading", { name: policy.name })).toHaveCount(0);
  expect(gateway.saves).toEqual([]);
});

test("모바일 정책 상세는 포커스와 가로 넘침 및 자동 접근성 검사를 통과한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 640 });
  gateway.writable(false);
  await login(page, true);
  await expect(detail(page).getByRole("heading", { name: policy.name })).toBeVisible();
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (target: string) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await axe.run('[role="dialog"]')).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  expect(await detail(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await detail(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: info.outputPath("policy-search-mobile.png") });
  expect(gateway.saves).toEqual([]);
});
