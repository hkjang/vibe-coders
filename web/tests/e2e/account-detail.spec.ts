import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installAccountPagination } from "../fixtures/account-pagination-browser";

test("조회 전용 계정 상세·목록 필터·새로고침·닫기 초점", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users/accounts?account_q=account-42%40&account_size=10");
  const link = page.getByRole("link", { name: "account-42@example.test 계정 상세 보기" });
  await link.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "로그인 계정 상세" });
  await expect(panel).toContainText("usr_page_042");
  await expect(panel).toContainText("공개 검증팀");
  await expect(panel.getByRole("button", { name: /저장|수정/u })).toHaveCount(0);
  expect(
    fixture.reads
      .filter((query) => query.has("id"))
      .at(-1)
      ?.get("id"),
  ).toBe("usr_page_042");
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(page).toHaveURL(/account_size=10/u);
  await link.click();
  await page.reload();
  await expect(panel).toContainText("usr_page_042");
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByLabel("계정 검색", { exact: true })).toHaveValue("account-42@");
  await expect(page).not.toHaveURL(/account_id=/u);
  fixture.check();
});

test("현재 페이지 밖의 계정과 미소속 계정을 주소로 직접 조회한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users/accounts?account_page=3&account_id=usr_page_000");
  const panel = page.getByRole("dialog", { name: "로그인 계정 상세" });
  await expect(panel).toContainText("usr_page_000");
  await expect(panel).toContainText("미소속");
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("table", { name: "로그인 계정 목록", exact: true })).toContainText(
    "account-50@example.test",
  );
  await expect(page).toHaveURL(/account_page=3/u);
  fixture.check();
});

test("없는 계정을 다른 행으로 대체하지 않고 상세 오류는 재시도한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.goto("access/users/accounts?account_id=missing");
  const panel = page.getByRole("dialog", { name: "로그인 계정 상세" });
  await expect(panel).toContainText("조회 가능한 로그인 계정이 없습니다.");
  let failed = true;
  await page.route(/\/admin\/users\?.*[?&]id=/u, (route) =>
    failed
      ? route.fulfill({
          status: 500,
          json: { error: { code: "fixture_failure", message: "private fixture" } },
        })
      : route.fallback(),
  );
  await page.goto("access/users/accounts?account_id=usr_page_042");
  await expect(panel).toContainText("로그인 계정 상세 조회 실패");
  failed = false;
  await panel.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(panel).toContainText("운영 계정 42");
  fixture.check();
});

test("상세 조회 권한 회수 시 계정 정보와 열린 창을 폐기한다", async ({ page }) => {
  const fixture = await installAccountPagination(page);
  await page.route(/\/admin\/users\?.*[?&]id=/u, (route) =>
    route.fulfill({ status: 403, json: { error: { code: "denied", message: "private fixture" } } }),
  );
  await page.goto("access/users/accounts?account_id=usr_page_042");
  await expect(page.getByText("사용자 조회 권한을 다시 확인하세요.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("account-42@example.test", { exact: true })).toHaveCount(0);
  fixture.check();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`계정 상세 키보드·접근성 ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installAccountPagination(page);
      await page.goto("access/users/accounts?account_q=account-42%40");
      const link = page.getByRole("link", { name: "account-42@example.test 계정 상세 보기" });
      await link.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("dialog", { name: "로그인 계정 상세" });
      await expect(panel).toContainText("운영 계정 42");
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press("Tab");
        expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map(
            (item) => item.id,
          ),
        ),
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`account-detail-${theme}-${viewport.width}.png`) });
      await page.keyboard.press("Escape");
      await expect(link).toBeFocused();
      fixture.check();
    });
  }
}
