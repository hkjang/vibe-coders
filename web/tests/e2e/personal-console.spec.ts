import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installPersonalConsole, personalRequest } from "../fixtures/personal-console-browser";

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
test("개인 리포트 기간과 부분 조회 오류 복구", async ({ page }) => {
  const fixture = await installPersonalConsole(page);
  fixture.state.dashboardStatus = 500;
  await page.goto("me?report_window=monthly");
  await expect(page.getByRole("alert")).toContainText("내 사용 현황 조회 실패");
  await expect(page.getByRole("region", { name: "리포트 지표" })).toContainText("감소");
  expect(fixture.reads.some((r) => r.path === "/me/report" && r.window === "monthly")).toBe(true);
  fixture.state.dashboardStatus = 200;
  await page.getByRole("alert").getByRole("button", { name: "다시 조회" }).click();
  await expect(page.getByRole("region", { name: "내 사용 요약" })).toContainText("48,200");
  await page.reload();
  await expect(page.getByLabel("리포트 기간")).toHaveValue("monthly");
  fixture.check();
});
test("요청 필터·페이지·검색·영수증 주소 복원", async ({ page }) => {
  const fixture = await installPersonalConsole(page);
  fixture.state.requests = Array.from({ length: 23 }, (_, index) => ({
    ...personalRequest,
    id: "public-request-" + String(index).padStart(2, "0"),
    status_code: 500,
    model: index === 22 ? "=1+2" : personalRequest.model,
  }));
  await page.goto("me?tab=requests&limit=50&request_status=error&requests_page=2&requests_sort=id");
  const table = page.getByRole("table", { name: "내 최근 요청" });
  await expect(table).toContainText("public-request-10");
  await page.reload();
  await page.getByRole("link", { name: "public-request-10", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "요청 영수증" });
  await expect(dialog).toContainText("public-request-10");
  await page.reload();
  await expect(dialog).toContainText("public-request-10");
  await dialog.getByRole("button", { name: "패널 닫기" }).click();
  await expect(dialog).not.toBeVisible();
  const form = page.getByRole("form", { name: "내 최근 요청 검색", exact: true });
  await form.getByRole("textbox").fill("public-request-22");
  await expect(form.getByRole("textbox")).toHaveValue("public-request-22");
  await form.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("requests_q")).toBe("public-request-22");
  await expect(table).toContainText("public-request-22");
  expect(new URL(page.url()).searchParams.has("requests_page")).toBe(false);
  const downloading = page.waitForEvent("download");
  await form.getByRole("button", { name: "검색 결과 CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("me-requests.csv");
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += String(chunk);
  expect(csv).toContain("public-request-22");
  expect(csv).toContain("'=1+2");
  expect(csv).not.toContain("public-request-10");
  fixture.check();
});
test("추천 조회와 명시적 재계산·의견 분리", async ({ page }) => {
  const fixture = await installPersonalConsole(page);
  await page.goto("me?tab=skills");
  await expect(page.getByText("공개 문서 요약 템플릿", { exact: false })).toBeVisible();
  expect(fixture.reads.filter((r) => r.refresh === "true")).toHaveLength(0);
  await page.getByRole("button", { name: "나중에", exact: true }).click();
  await expect(page.getByText("이 화면에서 기록한 의견: 나중에")).toBeVisible();
  expect(fixture.reads.filter((r) => r.refresh === "true")).toHaveLength(0);
  await page.getByRole("button", { name: "추천 새로 계산" }).click();
  await expect.poll(() => fixture.reads.filter((r) => r.refresh === "true").length).toBe(1);
  fixture.check();
});
test("읽기 전용 스킬과 추천은 전송 차단", async ({ page }) => {
  const fixture = await installPersonalConsole(page, true);
  await page.goto("me?tab=skills");
  await expect(page.getByRole("button", { name: "접근 신청" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "평가하기" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "추천 새로 계산" })).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.reads.filter((r) => r.refresh === "true")).toHaveLength(0);
  fixture.check();
});
test("스킬 신청 확인과 잘못된 응답의 중복 전송 보호", async ({ page }) => {
  const fixture = await installPersonalConsole(page);
  fixture.state.wrong = true;
  await page.goto("me?tab=skills");
  await page.getByRole("button", { name: "접근 신청" }).click();
  const dialog = page.getByRole("dialog", { name: "스킬 접근 신청" });
  await dialog.getByLabel("신청 사유").fill("공개 검토 사유");
  await dialog.getByRole("button", { name: "신청", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("처리 결과");
  await expect(dialog.getByRole("button", { name: "신청", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`개인 콘솔 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installPersonalConsole(page);
      await page.goto("me");
      await expect(page.getByRole("region", { name: "내 사용 요약" })).toContainText("48,200");
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      await expect.poll(() => violations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath("personal-home.png") });
      await page.getByRole("tab", { name: "요청·영수증" }).click();
      await page.getByRole("link", { name: "public-request", exact: true }).click();
      const receipt = page.getByRole("dialog", { name: "요청 영수증" });
      await expect(receipt).toContainText("공개 공급자");
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(receipt.getByRole("button", { name: "패널 닫기" })).toBeInViewport();
      const content = receipt.getByRole("region", { name: "영수증 상세 내용" });
      await content.focus();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await content.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath("personal-receipt.png") });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("link", { name: "public-request", exact: true })).toBeFocused();
      await page.getByRole("tab", { name: "스킬·추천" }).click();
      await page.getByRole("button", { name: "접근 신청" }).click();
      const dialog = page.getByRole("dialog", { name: "스킬 접근 신청" });
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(dialog.getByRole("button", { name: "취소" })).toBeInViewport();
      await page.screenshot({ path: info.outputPath("personal-skill.png") });
      await dialog.getByRole("button", { name: "취소" }).click();
      await expect(page.getByRole("button", { name: "접근 신청" })).toBeFocused();
      fixture.check();
    });
  }
  test(`개인 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installPersonalConsole(page);
    await page.goto("me");
    await expect(page.getByRole("region", { name: "내 사용 요약" })).toContainText("48,200");
    await expect(page.getByRole("region", { name: "내 사용 요약" })).toHaveScreenshot(
      `personal-home-${theme}.png`,
      { animations: "disabled" },
    );
    await page.getByRole("tab", { name: "스킬·추천" }).click();
    await page.getByRole("button", { name: "접근 신청" }).click();
    await expect(page.getByRole("dialog", { name: "스킬 접근 신청" })).toHaveScreenshot(
      `personal-skill-${theme}.png`,
      { animations: "disabled" },
    );
    fixture.check();
  });
}
