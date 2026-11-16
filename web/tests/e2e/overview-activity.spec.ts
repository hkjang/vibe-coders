import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installOverviewActivity } from "../fixtures/overview-activity-browser";

test("기간을 주소에 보존하고 세 영역의 요약과 상세 이동을 제공한다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  await page.goto("overview?range=7d");
  const region = page.getByRole("region", { name: "주의 신호와 최근 작업" });
  await expect(region.getByText("기본 공급자")).toBeVisible();
  await expect(region.getByText("전송 오류", { exact: true })).toBeVisible();
  const help = region.locator("summary").filter({ hasText: "집계 기준 보기" });
  await help.focus();
  await help.press("Enter");
  await expect(region.getByText(/UTC 기준 시간당/)).toBeVisible();
  await help.press("Enter");
  await expect(region.getByText(/UTC 기준 시간당/)).toBeHidden();
  expect(fixture.activity.reads).toHaveLength(3);
  expect(fixture.activity.reads.every((read) => read.window === "7d")).toBe(true);
  await page
    .getByRole("group", { name: "조회 기간", exact: true })
    .getByRole("button", { name: "1시간", exact: true })
    .click();
  await expect.poll(() => fixture.activity.reads.filter((read) => read.window === "1h").length).toBe(3);
  await page.reload();
  await expect(region.getByText("기본 공급자")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("range")).toBe("1h");
  expect(fixture.activity.detailReads).toEqual([]);
  const link = region.getByRole("link", { name: "전체 변경 이력 열기" });
  await expect(link).toHaveAttribute("href", "/app/system/settings?tab=audit");
  await link.focus();
  await link.press("Enter");
  await expect(page).toHaveURL(/system\/settings\?tab=audit$/);
  await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
  await expect.poll(() => fixture.activity.detailReads.length).toBe(2);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
test("알림 조회 거부는 다른 기록을 유지하고 키보드 재시도로 복구한다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  await page.goto("overview");
  await expect(page.getByText("전송 오류", { exact: true })).toBeVisible();
  fixture.activity.alertStatus = 403;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("전송 오류", { exact: true })).toHaveCount(0);
  await expect(page.getByText("기본 공급자")).toBeVisible();
  await expect(page.getByText("private-activity-detail")).toHaveCount(0);
  fixture.activity.alertStatus = 200;
  const retry = page.getByRole("button", { name: "최근 알림 재시도", exact: true });
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByText("전송 오류", { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
test("갱신 실패와 빈 기록을 구분하고 원문 오류를 표시하지 않는다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  await page.goto("overview");
  await expect(page.getByText("전송 오류", { exact: true })).toBeVisible();
  fixture.activity.alertStatus = 503;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("새 갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
  await expect(page.getByText("전송 오류", { exact: true })).toBeVisible();
  fixture.activity.alertStatus = 200;
  fixture.activity.empty = true;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("임계치 초과 없음")).toBeVisible();
  await expect(page.getByText(/전체 서비스의 정상 동작을 보장/)).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
test("숨긴 기능과 구버전 백엔드에서는 요약을 호출하지 않는다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  fixture.bootstrap.backend_version = "v0.86.128";
  await page.goto("overview");
  await expect(page.getByText("요약 미제공")).toHaveCount(3);
  expect(fixture.activity.reads).toEqual([]);
  fixture.bootstrap.backend_version = "v0.86.129";
  for (const feature of fixture.bootstrap.migration_registry) {
    if (feature.feature_id === "governance.policies") feature.status = "hidden";
    if (feature.feature_id === "system.settings") feature.status = "legacy";
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "최근 알림", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /전체 변경 이력 열기/ })).toHaveAttribute(
    "href",
    "/admin#/settings",
  );
  expect(fixture.activity.reads).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 최근 운영 활동 한글·키보드·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installOverviewActivity(page);
      await page.clock.install({ time: new Date("2026-11-17T03:00:00Z") });
      await page.setViewportSize({ width, height: width === 390 ? 3400 : 1200 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("overview?range=7d");
      const region = page.getByRole("region", { name: "주의 신호와 최근 작업", exact: true });
      await expect(region.getByText("기본 공급자")).toBeVisible();
      await expect(region.getByText("전송 오류", { exact: true })).toBeVisible();
      await region.getByRole("link", { name: "알림 기록 열기" }).focus();
      await region.evaluate((element) => element.scrollIntoView({ block: "center" }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await expect(region).toHaveScreenshot(`overview-activity-${theme}-${width}.png`, {
        animations: "disabled",
        mask: [region.locator(".health-widget-footer time")],
      });
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.writes).toEqual([]);
    });
  }
