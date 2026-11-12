import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installIpUsage } from "../fixtures/ip-usage-browser";
async function violations(page: Page) {
  return page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    return (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map(
      (violation) => ({ id: violation.id, impact: violation.impact, count: violation.nodes.length }),
    );
  });
}
test("IP 검색·다중 정렬·페이지·열 설정과 새로고침 복원", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto("access/users?tab=ips&ips_page=2&ips_sort=requests:desc,ip:asc");
  const table = page.getByRole("table", { name: "IP별 사용량" });
  await expect(table).toContainText("192.0.2.11");
  await expect(page).toHaveURL(/\/app\/access\/users\/ips\?/u);
  await page.reload();
  await expect(table).toContainText("192.0.2.11");
  await page.getByRole("button", { name: "다중 정렬", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "다중 정렬 설정" });
  await dialog.getByLabel("1순위 정렬 방향").selectOption("asc");
  await dialog.getByRole("button", { name: "정렬 적용" }).click();
  await expect(page).toHaveURL(/ips_sort=requests%3Aasc%2Cip%3Aasc/u);
  await expect(table).toContainText("IP 미기록");
  await page.getByRole("button", { name: "열 설정" }).click();
  await page.getByRole("dialog", { name: /열/u }).getByRole("button", { name: /닫기/u }).click();
  const form = page.getByRole("form", { name: "IP별 사용량 검색", exact: true });
  await form.getByRole("textbox").fill("192.0.2.24");
  await form.getByRole("button", { name: "검색", exact: true }).click();
  await expect(table.getByRole("link")).toHaveCount(1);
  await page.reload();
  await expect(form.getByRole("textbox")).toHaveValue("192.0.2.24");
  fixture.check();
});
test("IP 직접 주소와 분리된 탭 사이의 키보드 초점", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto("access/users/ips");
  await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
  await page.getByRole("tab", { name: "역할", exact: true }).click();
  await expect(page.getByRole("tab", { name: "역할", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "IP", exact: true }).click();
  await expect(page.getByRole("tab", { name: "IP", exact: true })).toBeFocused();
  await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
  fixture.check();
});
test("IPv6 상세 주소·실제 집계 필드·필터와 분리한 상세", async ({ page }) => {
  const fixture = await installIpUsage(page);
  await page.goto(
    "access/users?tab=ips&ips_q=no-match&ip=2001%3A0db8%3A%3A1&ip_view=distribution&ip_models_page=4",
  );
  const dialog = page.getByRole("dialog", { name: "2001:0db8::1" });
  await expect(dialog).toContainText("모델-35");
  await expect(dialog).toContainText("key_public_id");
  await page.reload();
  await expect(dialog).toContainText("모델-35");
  await dialog.getByRole("tab", { name: "요약·추이" }).click();
  await expect(dialog.getByRole("table", { name: "일별 사용량" })).toContainText("2026-11-12");
  await dialog.getByRole("tab", { name: "최근 요청" }).click();
  await expect(dialog.getByRole("link", { name: "req_public_ip" })).toHaveAttribute(
    "href",
    "/app/observability/requests?ip=2001%3A0db8%3A%3A1&request_id=req_public_ip",
  );
  await expect(dialog).not.toContainText("PRIVATE_");
  expect(fixture.reads.some((path) => path === "/admin/ips/2001%3A0db8%3A%3A1?limit=100")).toBe(true);
  fixture.check();
});
test("전체 검색 결과 CSV와 수식 보호", async ({ page }) => {
  const fixture = await installIpUsage(page);
  fixture.state.detail.by_model = fixture.state.detail.by_model.map((row, index) =>
    index === 0 ? { ...row, key: "=1+2" } : row,
  );
  await page.goto("access/users?tab=ips&ip=2001%3A0db8%3A%3A1&ip_view=distribution");
  const form = page.getByRole("form", { name: "모델별 사용량 검색", exact: true });
  await expect(page.getByRole("table", { name: "모델별 사용량" })).toContainText("=1+2");
  const downloading = page.waitForEvent("download");
  await form.getByRole("button", { name: "검색 결과 CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("ip_models.csv");
  const stream = await download.createReadStream();
  let csv = "";
  for await (const part of stream) csv += String(part);
  expect(csv).toContain("'=1+2");
  expect(csv).toContain("모델-35");
  expect(csv).not.toContain("PRIVATE_");
  fixture.check();
});
test("조회 오류 복구와 403 이후 목록·상세 제거", async ({ page }) => {
  const fixture = await installIpUsage(page);
  fixture.state.listStatus = 500;
  await page.goto("access/users?tab=ips");
  await expect(page.getByText("IP 목록 조회 실패")).toBeVisible();
  await expect(page.getByRole("region", { name: "조회된 IP 사용량 요약" })).toHaveCount(0);
  fixture.state.listStatus = 200;
  await page.getByRole("button", { name: "다시 시도" }).click();
  await page.getByRole("link", { name: "2001:0db8::1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "2001:0db8::1" });
  await expect(dialog.getByRole("table", { name: "일별 사용량" })).toBeVisible();
  fixture.state.detailStatus = 403;
  await dialog.getByRole("button", { name: "다시 조회" }).click();
  await expect(page.getByText("IP 사용량 조회 권한을 다시 확인하세요.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("table", { name: "IP별 사용량" })).toHaveCount(0);
  fixture.check();
});
test("요청 조회 권한 없는 사용자는 요청 연결 없이 IP 메타데이터 조회", async ({ page }) => {
  const fixture = await installIpUsage(page, false);
  await page.goto("access/users?tab=ips&ip=2001%3A0db8%3A%3A1&ip_view=requests");
  await expect(page.getByRole("dialog")).toContainText("req_public_ip");
  await expect(page.getByRole("link", { name: "req_public_ip" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "요청 탐색기", exact: true })).toHaveCount(0);
  fixture.check();
});
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`IP 사용량 접근성 ${theme} ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const fixture = await installIpUsage(page);
      await page.goto("access/users?tab=ips");
      const opener = page.getByRole("link", { name: "2001:0db8::1", exact: true });
      await expect(opener).toBeVisible();
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      await expect.poll(() => violations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      );
      await opener.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("table", { name: "일별 사용량" })).toBeVisible();
      await expect.poll(() => violations(page)).toEqual([]);
      await expect(dialog.getByRole("button", { name: "다시 조회" })).toBeInViewport();
      const region = dialog.getByRole("region", { name: "IP 사용량 상세 내용" });
      await region.focus();
      await expect(region).toBeFocused();
      if (viewport.height === 390) {
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: info.outputPath("ip-detail.png") });
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      fixture.check();
    });
  }
  test(`IP 사용량 시각 기준 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = await installIpUsage(page);
    await page.goto("access/users?tab=ips");
    await expect(page.getByRole("table", { name: "IP별 사용량" })).toBeVisible();
    await expect(page).toHaveScreenshot(`ip-list-${theme}.png`, {
      fullPage: true,
      animations: "disabled",
      mask: [page.getByText(/마지막 갱신/u)],
    });
    await page.getByRole("link", { name: "2001:0db8::1", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("table", { name: "일별 사용량" })).toBeVisible();
    await expect(dialog).toHaveScreenshot(`ip-detail-${theme}.png`, {
      animations: "disabled",
      mask: [dialog.getByText(/마지막 갱신/u)],
    });
    fixture.check();
  });
}
