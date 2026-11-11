import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installTeamPortal, teamReport } from "../fixtures/team-portal-browser";

async function openReview(page: Page) {
  await page.getByRole("button", { name: "승인", exact: true }).first().click();
  return page.getByRole("dialog", { name: "리포트 승인" });
}
async function violations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
    return result.violations.map((entry) => ({
      id: entry.id,
      impact: entry.impact,
      count: entry.nodes.length,
    }));
  });
}
test("한글 팀 명시 적용과 90일 조회·새로고침", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  await page.goto("team");
  await page.getByRole("textbox", { name: "팀", exact: true }).fill("데이터 플랫폼");
  expect(fixture.reads.some((read) => read.team === "데이터 플랫폼")).toBe(false);
  await page.getByRole("button", { name: "팀 적용" }).click();
  await expect(page.locator(".team-scope-summary")).toContainText("데이터 플랫폼");
  await page.getByLabel("사용량 조회 기간").selectOption("90d");
  await expect
    .poll(() => fixture.reads.filter((read) => read.path === "/team/dashboard").at(-1)?.window)
    .toBe("2160h");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "팀", exact: true })).toHaveValue("데이터 플랫폼");
  await expect(page.getByLabel("사용량 조회 기간")).toHaveValue("90d");
  fixture.check();
});
test("리포트 정렬·페이지·검색과 주소 복원", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  fixture.state.reports = Array.from({ length: 23 }, (_, index) => ({
    ...teamReport,
    id: "public-report-" + index,
    name: "공개 보고서 " + String(index).padStart(2, "0"),
  }));
  await page.goto("team?reports_page=2&reports_sort=name&reports_direction=asc");
  await expect(page.getByRole("table", { name: "팀 공용 리포트" })).toContainText("공개 보고서 10");
  await page.reload();
  const form = page.getByRole("form", { name: "팀 공용 리포트 검색", exact: true });
  await form.getByRole("textbox").fill("공개 보고서 22");
  await form.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("table", { name: "팀 공용 리포트" })).toContainText("공개 보고서 22");
  expect(new URL(page.url()).searchParams.has("reports_page")).toBe(false);
  fixture.check();
});
test("선택 팀 승인 검토와 사유·변경 전 확인", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  await page.goto("team?team=" + encodeURIComponent("데이터 플랫폼"));
  const dialog = await openReview(page);
  await expect(dialog).toContainText("데이터 플랫폼");
  await expect(dialog.getByLabel("리포트 SQL")).toContainText("SELECT model");
  await expect(dialog.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
  await dialog.getByLabel("변경 사유").fill("공유 범위와 쿼리 검토 완료");
  await dialog.getByRole("button", { name: "승인", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(fixture.writes).toEqual([
    {
      path: "/team/reports",
      team: "데이터 플랫폼",
      body: { report_id: teamReport.id, action: "approve", reason: "공유 범위와 쿼리 검토 완료" },
    },
  ]);
  fixture.check();
});
test("검토 이후 변경된 내용과 읽기 전용 보호", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  await page.goto("team");
  const dialog = await openReview(page);
  await dialog.getByLabel("변경 사유").fill("검토 완료");
  fixture.state.reports[0] = { ...teamReport, sql: "SELECT 2", revision: "b".repeat(64) };
  await dialog.getByRole("button", { name: "승인", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("변경됐습니다");
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("불확실한 승인 응답 뒤 재전송 차단", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  fixture.state.wrong = true;
  await page.goto("team");
  const dialog = await openReview(page);
  await dialog.getByLabel("변경 사유").fill("검토 완료");
  await dialog.getByRole("button", { name: "승인", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("처리 결과");
  await expect(dialog.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
test("읽기 전용 포털과 메타데이터 CSV", async ({ page }) => {
  const fixture = await installTeamPortal(page, true);
  await page.goto("team");
  await expect(page.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "팀 포털" }).click();
  await expect(page.getByRole("table", { name: "팀 API 키" })).toContainText("공개 빌드 키");
  const download = page.waitForEvent("download");
  await page
    .getByRole("form", { name: "팀 API 키 검색", exact: true })
    .getByRole("button", { name: "검색 결과 CSV" })
    .click();
  expect((await download).suggestedFilename()).toBe("team-keys.csv");
  expect(fixture.writes).toHaveLength(0);
  fixture.check();
});
test("대시보드 오류 후 개별 재조회", async ({ page }) => {
  const fixture = await installTeamPortal(page);
  fixture.state.dashboardStatus = 500;
  await page.goto("team");
  await expect(page.getByRole("alert")).toContainText("팀 사용량");
  await expect(page.getByRole("table", { name: "팀 공용 리포트" })).toContainText(teamReport.name);
  fixture.state.dashboardStatus = 200;
  await page.getByRole("alert").getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("table", { name: "팀 모델 사용" })).toContainText("public-balanced");
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`팀 검토·포털 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installTeamPortal(page);
      await page.goto("team");
      const dialog = await openReview(page);
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(dialog.getByRole("button", { name: "취소" })).toBeInViewport();
      await page.screenshot({ path: info.outputPath("team-review.png") });
      await dialog.getByRole("button", { name: "취소" }).click();
      await expect(page.getByRole("button", { name: "승인", exact: true })).toBeFocused();
      await page.getByRole("tab", { name: "팀 포털" }).click();
      await expect(page.getByRole("table", { name: "팀 API 키" })).toContainText("공개 빌드 키");
      await expect.poll(() => violations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath("team-portal.png") });
      fixture.check();
    });
  }
  test(`팀 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installTeamPortal(page);
    await page.goto("team");
    const dialog = await openReview(page);
    await expect(dialog).toHaveScreenshot(`team-review-${theme}.png`, { animations: "disabled" });
    await dialog.getByRole("button", { name: "취소" }).click();
    await page.getByRole("tab", { name: "팀 포털" }).click();
    await expect(page.getByRole("table", { name: "팀 API 키" })).toContainText("공개 빌드 키");
    const card = page
      .locator(".section-card")
      .filter({ has: page.getByRole("heading", { name: "팀 API 키", exact: true }) });
    await expect(card).toHaveScreenshot(`team-portal-${theme}.png`, { animations: "disabled" });
    fixture.check();
  });
}
