import { expect, type Page } from "@playwright/test";
import { alpha, firstEmail, targetUrl, test } from "../fixtures/app-permission-gateway";

const detail = { ...alpha, icon: "app", created_at: "2026-09-01T00:00:00Z" };
async function openDelete(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("button", { name: `${alpha.title} 상세 열기`, exact: true }).click();
  await page
    .getByRole("dialog", { name: alpha.title, exact: true })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "업무 앱 삭제", exact: true });
  await expect(dialog.getByRole("textbox", { name: "확인 문구", exact: true })).toBeVisible();
  return dialog;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} 좁은 화면에서 삭제 대상 확인·키보드·접근성을 검증한다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    let reads = 0;
    let deletes = 0;
    await page.route(`**/admin/apps/${alpha.id}`, (route) => {
      if (route.request().method() === "GET") {
        reads++;
        return route.fulfill({ json: detail });
      }
      expect(route.request().method()).toBe("DELETE");
      deletes++;
      return route.fulfill({ json: { status: "deleted" } });
    });
    const dialog = await openDelete(page);
    const submit = dialog.getByRole("button", { name: "삭제", exact: true });
    const input = dialog.getByRole("textbox", { name: "확인 문구", exact: true });
    await expect(submit).toBeDisabled();
    await input.fill(`${alpha.id} `);
    await expect(submit).toBeDisabled();
    await input.fill(alpha.id);
    await expect(submit).toBeEnabled();
    await expect(submit).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      return (await axe.run(document)).violations.map((v) => v.id);
    });
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`app-delete-${colorScheme}.png`) });
    const before = reads;
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    expect(reads).toBe(before + 1);
    expect(deletes).toBe(1);
    expect(gateway.unexpected).toEqual([]);
  });
}

test("정의 변경은 삭제를 차단하고 취소 시 상세창의 삭제 버튼으로 초점을 돌린다", async ({
  page,
  gateway,
}) => {
  let changed = false;
  let deletes = 0;
  await page.route(`**/admin/apps/${alpha.id}`, (route) => {
    if (route.request().method() === "DELETE") deletes++;
    return route.fulfill({ json: changed ? { ...detail, allowed_teams: "another-team" } : detail });
  });
  const dialog = await openDelete(page);
  changed = true;
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(alpha.id);
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog.getByText(/앱 정보가 변경되었습니다/u)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("dialog", { name: alpha.title, exact: true })
      .getByRole("button", { name: "삭제", exact: true }),
  ).toBeFocused();
  expect(deletes).toBe(0);
  expect(gateway.unexpected).toEqual([]);
});

for (const status of [401, 500, 200]) {
  test(`삭제 응답 ${status}${status === 200 ? " 형식 오류" : ""} 뒤에는 재전송하지 않는다`, async ({
    page,
    gateway,
  }) => {
    let deletes = 0;
    await page.route(`**/admin/apps/${alpha.id}`, (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: detail });
      expect(route.request().method()).toBe("DELETE");
      deletes++;
      return route.fulfill({
        status,
        headers: { "X-Request-ID": "req_delete_uncertain" },
        json: { error: "private-backend-detail" },
      });
    });
    const dialog = await openDelete(page);
    await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(alpha.id);
    await dialog.getByRole("button", { name: "삭제", exact: true }).click();
    await expect(dialog.getByText(/목록과 감사 이력을 확인하세요/u)).toBeVisible();
    await expect(dialog.getByText(/req_delete_uncertain/u)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
    await expect(dialog.getByText(/private-backend-detail/u)).toHaveCount(0);
    expect(deletes).toBe(1);
    expect(gateway.unexpected).toEqual([]);
  });
}
