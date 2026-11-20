import { Buffer } from "node:buffer";
import { expect, type Page } from "@playwright/test";
import { test, firstEmail, targetUrl } from "../fixtures/skill-fitness-gateway";

async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "스킬", exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
  await page.clock.install();
}
async function remainsUntilClosed(page: Page, message: string) {
  const notice = page.getByText(message, { exact: true });
  await expect(notice).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5500);
  await expect(notice).toBeVisible();
  const close = page.getByRole("button", { name: "알림 닫기", exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await page.clock.runFor(1000);
  await expect(notice).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`스킬 내보내기 오류는 ${width}px에서 유지하고 키보드로 닫는다`, async ({ page, gateway }, info) => {
    let calls = 0;
    await page.route("**/admin/skills/export", (route) => {
      calls++;
      return route.fulfill({ status: 500, json: { error: { message: "private upstream failure" } } });
    });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light", reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    await login(page);
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.locator("html").evaluate((element) => {
        element.style.fontSize = "20px";
      });
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    const message = "서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.";
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      }),
    ).toEqual([]);
    await page.locator("[data-sonner-toast]").screenshot({ path: info.outputPath("export-error.png") });
    await remainsUntilClosed(page, message);
    await expect(page.getByText(/private upstream/)).toHaveCount(0);
    expect(calls).toBe(1);
    expect(gateway.unexpected).toEqual([]);
  });
}

for (const [content, message] of [
  ["{", "번들 파일이 올바른 JSON이 아닙니다."],
  ['{"skills":{}}', "번들 파일에 skills 배열이 없습니다."],
]) {
  test(`스킬 가져오기 검증 오류는 직접 닫을 때까지 유지한다: ${content}`, async ({ page, gateway }) => {
    let writes = 0;
    await page.route("**/admin/skills/import", (route) => {
      writes++;
      return route.fulfill({ json: {} });
    });
    await login(page);
    await page.getByLabel("가져오기", { exact: true }).setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(content ?? ""),
    });
    if (!message) throw new Error("알림 검증 문구가 필요합니다.");
    await remainsUntilClosed(page, message);
    expect(writes).toBe(0);
    expect(gateway.unexpected).toEqual([]);
  });
}

test("성공한 내보내기 알림은 자동 종료하고 다운로드는 한 번만 실행한다", async ({ page, gateway }) => {
  let calls = 0;
  await page.route("**/admin/skills/export", (route) => {
    calls++;
    return route.fulfill({ json: { version: "1", skills: [] } });
  });
  await login(page);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe("skills-bundle.json");
  const notice = page.getByText("스킬 번들을 내려받았습니다.", { exact: true });
  await expect(notice).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5500);
  await expect(notice).toHaveCount(0);
  expect(calls).toBe(1);
  expect(gateway.unexpected).toEqual([]);
});
