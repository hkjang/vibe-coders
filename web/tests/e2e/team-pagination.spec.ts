import { expect, test } from "@playwright/test";
import type axe from "axe-core";
import { installTeamPagination } from "../fixtures/team-pagination-browser";

test("팀 검색·페이지를 서버에 전달하고 새로고침 후 복원한다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  await page.goto("access/users?tab=teams&registered_page=2&registered_size=10");
  const table = page.getByRole("table", { name: "등록된 팀 목록", exact: true });
  await expect(table).toContainText("운영팀 10");
  expect(fixture.reads[0]?.get("offset")).toBe("10");
  await page.reload();
  await expect(table).toContainText("운영팀 10");
  await page.getByLabel("팀 검색", { exact: true }).fill("운영팀 42");
  const apply = page.getByRole("button", { name: "필터 적용", exact: true });
  await apply.click();
  await expect(table).toContainText("운영팀 42");
  await expect(apply).toBeFocused();
  expect(fixture.reads.at(-1)?.get("offset")).toBe("0");
  await page.reload();
  await expect(table).toContainText("운영팀 42");
  await expect(page.getByLabel("팀 검색", { exact: true })).toHaveValue("운영팀 42");
  fixture.check();
});

test("현재 팀 페이지 CSV는 수식과 보호된 식별자를 안전하게 내보낸다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  const protectedTeam = fixture.rows[1];
  if (!protectedTeam) throw new Error("Team pagination fixture requires a second team");
  protectedTeam.id = "vc_sk_" + "a".repeat(43);
  await page.goto("access/users?tab=teams&registered_size=10");
  const table = page.getByRole("table", { name: "등록된 팀 목록", exact: true });
  await expect(table).toContainText("보호된 팀 ID");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "현재 페이지 CSV" }).click();
  const stream = await (await download).createReadStream();
  if (!stream) throw new Error("CSV download stream unavailable");
  let csv = "";
  for await (const chunk of stream) csv += String(chunk);
  expect(csv).toContain("'=1+1");
  expect(csv).toContain("2026-11-12T00:00:00Z");
  expect(csv).toContain("보호된 팀 ID");
  expect(csv).not.toContain("vc_sk_");
  expect(csv).not.toContain("운영팀 10");
  fixture.check();
});

test("등록 팀 조회 실패를 0건으로 표시하지 않고 재시도한다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  fixture.state.registeredStatus = 500;
  await page.goto("access/users?tab=teams");
  await expect(page.getByText("등록 팀 목록을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText(/등록 팀 수 미확인/u)).toBeVisible();
  await expect(page.getByText(/검색 결과 0개 팀/u)).toHaveCount(0);
  fixture.state.registeredStatus = 200;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table", { name: "등록된 팀 목록", exact: true })).toContainText("운영팀 01");
  fixture.check();
});

test("팀 사용량 오류에도 등록 팀 목록과 수정 기능을 유지한다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  fixture.state.usageStatus = 500;
  await page.goto("access/users?tab=teams");
  await expect(page.getByText("팀 사용량을(를) 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByRole("table", { name: "등록된 팀 목록", exact: true })).toContainText("운영팀 01");
  await expect(page.getByRole("button", { name: "팀 추가", exact: true })).toBeEnabled();
  fixture.check();
});

test("범위 밖 팀 페이지는 마지막 페이지로 복구한다", async ({ page }) => {
  const fixture = await installTeamPagination(page);
  await page.goto("access/users?tab=teams&registered_page=20");
  await expect(page.getByText(/검색 결과 61개 팀/u)).toBeVisible();
  await page.getByRole("button", { name: "마지막 페이지로 이동" }).click();
  await expect(page.getByRole("table", { name: "등록된 팀 목록", exact: true })).toContainText("운영팀 50");
  await expect(page).toHaveURL(/registered_page=3/u);
  fixture.check();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`팀 필터·정렬의 키보드와 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installTeamPagination(page);
      await page.goto("access/users?tab=teams");
      const table = page.getByRole("table", { name: "등록된 팀 목록", exact: true });
      await expect(table).toContainText("운영팀 01");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("link", { name: "사용자 화면", exact: true })).toHaveCSS(
        "text-decoration-line",
        "underline",
      );
      await page.getByLabel("팀 검색", { exact: true }).focus();
      await page.keyboard.type("team_page_042");
      await page.keyboard.press("Enter");
      await expect(table).toContainText("운영팀 42");
      await expect(page.getByLabel("팀 검색", { exact: true })).toBeFocused();
      const trigger = page.getByRole("button", { name: "다중 정렬", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "다중 정렬 설정" })).toBeVisible();
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
        ),
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(
        await page.evaluate(async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => v.id),
        ),
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("team-pagination.png") });
      fixture.check();
    });
  }
}
for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`등록 팀 시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installTeamPagination(page);
      await page.goto("access/users?tab=teams&registered_q=team_page_042");
      await expect(page.getByRole("table", { name: "등록된 팀 목록", exact: true })).toContainText(
        "운영팀 42",
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page).toHaveScreenshot(`team-pagination-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
        mask: [page.locator(".updated-at")],
      });
      fixture.check();
    });
  }
}
