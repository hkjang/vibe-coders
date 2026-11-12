import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installTeamPagination } from "../fixtures/team-pagination-browser";

test("조회 전용 팀 상세 링크·필터·새로고침·닫기 초점", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  const user = fixture.bootstrap.user;
  if (!user?.scopes) throw new Error("Missing authenticated user fixture");
  user.scopes = user.scopes.filter((scope) => scope !== "admin:write");
  const feature = fixture.bootstrap.migration_registry?.find((item) => item.feature_id === "access.users");
  if (!feature) throw new Error("Missing access fixture");
  feature.read_only = true;
  await page.goto("access/users?tab=teams&registered_q=team_page_042&registered_size=10");
  const link = page.getByRole("link", { name: "운영팀 42 등록 정보 보기" });
  await link.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "등록 팀 상세" });
  await expect(panel).toContainText("team_page_042");
  await expect(panel.getByRole("button", { name: /저장|수정/u })).toHaveCount(0);
  expect(fixture.reads.at(-1)?.get("id")).toBe("team_page_042");
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(page).toHaveURL(/registered_size=10/u);
  await link.click();
  await page.reload();
  await expect(panel).toContainText("team_page_042");
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByLabel("팀 검색", { exact: true })).toHaveValue("team_page_042");
  fixture.check();
});

test("없는 팀의 상세를 목록의 다른 팀으로 대체하지 않는다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  await page.goto("access/users?tab=teams&registered_team=missing-team");
  const panel = page.getByRole("dialog", { name: "등록 팀 상세" });
  await expect(panel).toContainText("조회 가능한 등록 팀이 없습니다.");
  await expect(panel.getByText("운영팀 01")).toHaveCount(0);
  fixture.check();
});

test("상세만 실패해도 같은 ID로 재시도할 수 있다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  let failed = true;
  await page.route(/\/admin\/teams\?.*[?&]id=/u, async (route) => {
    if (!failed) return route.fallback();
    return route.fulfill({
      status: 500,
      json: { error: { code: "fixture_failure", message: "private fixture" } },
    });
  });
  await page.goto("access/users?tab=teams&registered_team=team_page_042");
  const panel = page.getByRole("dialog", { name: "등록 팀 상세" });
  await expect(panel).toContainText("등록 팀 상세을(를) 불러오지 못했습니다.");
  failed = false;
  await panel.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(panel).toContainText("운영팀 42");
  fixture.check();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`등록 팀 상세 키보드·접근성 ${theme} ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installTeamPagination(page);
      await page.goto("access/users?tab=teams&registered_q=team_page_042");
      const link = page.getByRole("link", { name: "운영팀 42 등록 정보 보기" });
      await link.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("dialog", { name: "등록 팀 상세" });
      await expect(panel).toContainText("운영팀 42");
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
      await page.keyboard.press("Escape");
      await expect(link).toBeFocused();
      fixture.check();
    });
  }
}
for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`등록 팀 상세 시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installTeamPagination(page);
      await page.goto("access/users?tab=teams&registered_team=team_page_042");
      await expect(page.getByRole("dialog", { name: "등록 팀 상세" })).toContainText("운영팀 42");
      await expect(page).toHaveScreenshot(`registered-team-detail-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
        mask: [page.locator(".updated-at")],
      });
      fixture.check();
    });
  }
}
