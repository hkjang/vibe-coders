import { expect, type Page } from "@playwright/test";
import { alpha, firstEmail, targetUrl, test } from "../fixtures/app-permission-gateway";

async function edit(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("button", { name: `${alpha.title} 상세 열기`, exact: true }).click();
  await page
    .getByRole("dialog", { name: alpha.title, exact: true })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  return page.getByRole("dialog", { name: "AI 업무 앱 수정", exact: true });
}
for (const colorScheme of ["light", "dark"] as const)
  test(`${colorScheme} 좁은 화면에서 변경 비교·확인·저장을 키보드로 수행한다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    const writes: unknown[] = [];
    await page.route(`**/admin/apps/${alpha.id}`, (route) => {
      expect(route.request().method()).toBe("PATCH");
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: alpha });
    });
    const form = await edit(page);
    const title = form.getByRole("textbox", { name: "제목", exact: true });
    await title.fill("  변경할 업무 앱  ");
    const save = form.getByRole("button", { name: "수정 저장", exact: true });
    await expect(save).toBeDisabled();
    const review = form.getByRole("button", { name: "변경 내용 검토", exact: true });
    await review.focus();
    await page.keyboard.press("Enter");
    await expect(form.getByRole("heading", { name: "변경 내용과 적용 범위", exact: true })).toBeFocused();
    const table = form.getByRole("table", { name: "업무 앱 변경 전후", exact: true });
    await expect(table).toContainText(alpha.title);
    await expect(table).toContainText("변경할 업무 앱");
    const check = form.getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true });
    await check.focus();
    await page.keyboard.press("Space");
    await expect(save).toBeEnabled();
    await expect(save).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await form.evaluate(async (element) => {
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
    await page.screenshot({ path: info.outputPath(`app-definition-${colorScheme}.png`) });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(form).toBeHidden();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({
        title: "변경할 업무 앱",
        allowed_teams: alpha.allowed_teams,
        allowed_roles: alpha.allowed_roles,
      }),
    );
    expect(gateway.unexpected).toEqual([]);
  });

test("검토 후 입력 변경은 확인을 취소하고 늦은 준비도 결과를 숨긴다", async ({ page, gateway }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/admin/apps/onboarding-check", async (route) => {
    calls++;
    await gate;
    return route.fulfill({
      json: {
        ready: true,
        missing: 0,
        checks: ["title", "owner", "components"].map((key) => ({
          key,
          severity: "required",
          ok: true,
          detail: "공개 점검",
        })),
      },
    });
  });
  try {
    const form = await edit(page);
    await form.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
    await form.getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다.", exact: true }).check();
    await form.getByRole("button", { name: "온보딩 준비도 확인", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    const title = form.getByRole("textbox", { name: "제목", exact: true });
    await title.fill("바뀐 값");
    await title.fill(alpha.title);
    await expect(form.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/admin/apps/onboarding-check",
    );
    release();
    await response;
    await expect(form.getByRole("list", { name: "온보딩 준비도 점검 결과", exact: true })).toHaveCount(0);
    await expect(
      form.getByText("입력이 변경되었습니다. 준비도를 다시 확인하세요.", { exact: true }),
    ).toBeVisible();
    expect(gateway.writes).toEqual([]);
  } finally {
    release();
  }
});
