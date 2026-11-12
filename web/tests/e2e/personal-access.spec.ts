import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { accessSession, installPersonalAccess } from "../fixtures/personal-access-browser";
async function violations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    return (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      count: v.nodes.length,
    }));
  });
}
test("세션 검색·정렬·페이지·CSV와 주소 복원", async ({ page }) => {
  const fixture = await installPersonalAccess(page);
  fixture.state.sessions.push(
    ...Array.from({ length: 22 }, (_, i) => ({
      ...accessSession,
      id: "public-extra-" + String(i).padStart(2, "0"),
      ip: "192.0.2." + (30 + i),
      user_agent: i === 21 ? "=1+2" : "공개 추가 브라우저",
    })),
  );
  await page.goto("me?tab=keys&login_sessions_page=2&login_sessions_sort=id");
  const table = page.getByRole("table", { name: "로그인 세션" });
  await expect(table).toContainText("public-extra-08");
  await page.reload();
  await expect(table).toContainText("public-extra-08");
  const form = page.getByRole("form", { name: "로그인 세션 검색", exact: true });
  await form.getByRole("textbox").fill("public-extra-21");
  await form.getByRole("button", { name: "검색", exact: true }).click();
  await expect(table).toContainText("public-extra-21");
  await page.reload();
  await expect(form.getByRole("textbox")).toHaveValue("public-extra-21");
  const downloading = page.waitForEvent("download");
  await form.getByRole("button", { name: "검색 결과 CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("me-login_sessions.csv");
  const stream = await download.createReadStream();
  let csv = "";
  for await (const part of stream) csv += String(part);
  expect(csv).toContain("'=1+2");
  expect(csv).not.toContain("public-current");
  fixture.check();
});
test("세션 종료 확인·현재 세션 보호·최신 목록 재조회", async ({ page }) => {
  const fixture = await installPersonalAccess(page);
  await page.goto("me?tab=keys");
  const current = page.getByRole("row").filter({ hasText: "현재 브라우저" });
  await expect(current.getByRole("button", { name: "종료" })).toBeDisabled();
  const row = page.getByRole("row").filter({ hasText: "public-device" });
  await row.getByRole("button", { name: "종료" }).click();
  const dialog = page.getByRole("dialog", { name: "세션 종료" });
  await expect(dialog).toContainText("192.0.2.20");
  expect(fixture.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "종료", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  expect(fixture.writes.map((w) => w.path)).toEqual(["/me/sessions/public-device"]);
  expect(fixture.reads.filter((r) => r.path === "/me/sessions").length).toBeGreaterThanOrEqual(3);
  fixture.check();
});
test("세션 조회 실패 복구와 잘못된 종료 응답 보호", async ({ page }) => {
  const fixture = await installPersonalAccess(page);
  fixture.state.sessionsStatus = 500;
  await page.goto("me?tab=keys");
  const error = page.getByRole("alert").filter({ hasText: "로그인 세션 조회 실패" });
  await expect(error).toBeVisible();
  fixture.state.sessionsStatus = 200;
  await error.getByRole("button", { name: "다시 조회" }).click();
  fixture.state.wrong = true;
  await page
    .getByRole("row")
    .filter({ hasText: "public-device" })
    .getByRole("button", { name: "종료" })
    .click();
  const dialog = page.getByRole("dialog", { name: "세션 종료" });
  await dialog.getByRole("button", { name: "종료", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("처리 결과");
  await expect(dialog.getByRole("button", { name: "종료", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("도구 선택·설정 복사·명시적 연결 진단·새로고침 복원", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const fixture = await installPersonalAccess(page);
  await page.goto("me?tab=keys&connection_client=cursor");
  await expect(page.getByLabel("클라이언트")).toHaveValue("cursor");
  expect(fixture.writes).toHaveLength(0);
  await page.getByRole("button", { name: "설정 불러오기" }).click();
  await page.getByRole("button", { name: "HTTP MCP 설정 복사" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied).mcpServers["vibe-gateway"].headers.Authorization).toBe("Bearer <YOUR_API_KEY>");
  expect(copied).not.toContain("ignored server command");
  await page.getByRole("button", { name: "진단 실행" }).click();
  await expect(page.getByText("브라우저 로그인 설정 검사", { exact: false })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel("클라이언트")).toHaveValue("cursor");
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("읽기 전용은 세션 종료·진단을 차단하고 설정 조회는 제공", async ({ page }) => {
  const fixture = await installPersonalAccess(page, true);
  await page.goto("me?tab=keys");
  await expect(page.getByRole("button", { name: "다른 세션 모두 종료" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "진단 실행" })).toBeDisabled();
  await page.getByRole("button", { name: "설정 불러오기" }).click();
  await expect(page.getByRole("region", { name: "Python SDK 설정 내용" })).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`개인 연결 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installPersonalAccess(page);
      await page.goto("me?tab=keys");
      await page.getByRole("button", { name: "설정 불러오기" }).click();
      await page.getByRole("button", { name: "진단 실행" }).click();
      await expect(page.getByText("브라우저 로그인 설정 검사", { exact: false })).toBeVisible();
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      await expect.poll(() => violations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      const code = page.getByRole("region", { name: "HTTP MCP 설정 내용" });
      await code.focus();
      await expect(code).toBeFocused();
      await page.screenshot({ path: info.outputPath("personal-connection.png") });
      const trigger = page
        .getByRole("row")
        .filter({ hasText: "public-device" })
        .getByRole("button", { name: "종료" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "세션 종료" });
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(dialog.getByRole("button", { name: "취소" })).toBeInViewport();
      const details = dialog.getByRole("region", { name: "종료할 세션 상세" });
      await details.focus();
      await expect(details).toBeFocused();
      if (viewport.height === 390) {
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: info.outputPath("personal-session.png") });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      fixture.check();
    });
  }
  test(`개인 연결 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installPersonalAccess(page);
    await page.goto("me?tab=keys");
    await page.getByRole("button", { name: "설정 불러오기" }).click();
    const pack = page
      .locator(".section-card")
      .filter({ has: page.getByRole("heading", { name: "연결 설정", exact: true }) });
    await expect(page.getByRole("region", { name: "Python SDK 설정 내용" })).toBeVisible();
    await expect(pack).toHaveScreenshot(`personal-connection-${theme}.png`, {
      animations: "disabled",
      mask: [pack.getByText(/마지막 갱신/u)],
    });
    await page
      .getByRole("row")
      .filter({ hasText: "public-device" })
      .getByRole("button", { name: "종료" })
      .click();
    await expect(page.getByRole("dialog", { name: "세션 종료" })).toHaveScreenshot(
      `personal-session-${theme}.png`,
      { animations: "disabled" },
    );
    fixture.check();
  });
}
