import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installOverviewServices } from "../fixtures/overview-service-browser";

test("서비스별 집계 기간을 구분하고 주소·새로고침에서 선택 기간을 복원한다", async ({ page }) => {
  const fixture = await installOverviewServices(page);
  await page.goto("overview?range=7d");
  const region = page.getByRole("region", { name: "연결 서비스", exact: true });
  await expect(region.getByText("1,234", { exact: true })).toBeVisible();
  await expect(region.getByText("95%", { exact: true })).toBeVisible();
  expect(fixture.services.windows).toEqual(["7d"]);
  await page
    .getByRole("group", { name: "조회 기간", exact: true })
    .getByRole("button", { name: "1시간", exact: true })
    .click();
  await expect.poll(() => fixture.services.windows.at(-1)).toBe("1h");
  expect(fixture.services.reads.filter((path) => path === "/admin/mcp/overview")).toHaveLength(1);
  await page.reload();
  await expect(region.getByText("95%", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("range")).toBe("1h");
  expect(fixture.services.windows.at(-1)).toBe("1h");
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("서비스 조회 거부는 해당 기록만 지우고 명시 재시도로 복구한다", async ({ page }) => {
  const fixture = await installOverviewServices(page);
  await page.goto("overview");
  await expect(page.getByText("1,234", { exact: true })).toBeVisible();
  fixture.services.mcpStatus = 403;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("1,234", { exact: true })).toHaveCount(0);
  await expect(page.getByText("95%", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "MCP 상태 열기", exact: true })).toBeVisible();
  const denied = fixture.services.reads.filter((path) => path === "/admin/mcp/overview").length;
  await page
    .getByRole("group", { name: "조회 기간", exact: true })
    .getByRole("button", { name: "7일", exact: true })
    .click();
  await expect.poll(() => fixture.services.windows.at(-1)).toBe("7d");
  expect(fixture.services.reads.filter((path) => path === "/admin/mcp/overview")).toHaveLength(denied);
  fixture.services.mcpStatus = 200;
  const retry = page.getByRole("button", { name: "MCP 도구 호출 재시도", exact: true });
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByText("1,234", { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("일시 오류의 마지막 정상 데이터와 빈 기록을 구분한다", async ({ page }) => {
  const fixture = await installOverviewServices(page);
  await page.goto("overview");
  await expect(page.getByText("95%", { exact: true })).toBeVisible();
  fixture.services.textStatus = 503;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("새 갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
  await expect(page.getByText("95%", { exact: true })).toBeVisible();
  await expect(page.getByText("private-service-detail")).toHaveCount(0);
  fixture.services.textStatus = 200;
  fixture.services.empty = true;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("처리 기록 없음", { exact: true })).toBeVisible();
  await expect(page.getByText("미설정", { exact: true })).toBeVisible();
  await expect(page.getByText("발견 기록 없음", { exact: false })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("이전 백엔드·숨겨진 기능·기존 화면 단계에서 지원하지 않는 요약을 요청하지 않는다", async ({ page }) => {
  const fixture = await installOverviewServices(page);
  fixture.bootstrap.backend_version = "v0.86.127";
  await page.goto("overview");
  await expect(page.getByText("요약 미제공", { exact: true })).toHaveCount(2);
  expect(fixture.services.reads).toEqual([]);
  fixture.bootstrap.backend_version = "v0.86.128";
  for (const feature of fixture.bootstrap.migration_registry) {
    if (feature.feature_id === "mcp.overview") feature.status = "hidden";
    if (feature.feature_id === "text2sql.overview") feature.status = "legacy";
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "MCP 도구 호출", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Text2SQL 현황 열기/ })).toHaveAttribute(
    "href",
    "/admin#/text2sql",
  );
  expect(fixture.services.reads).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 연결 서비스의 한글·키보드·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installOverviewServices(page);
      await page.setViewportSize({ width, height: width === 390 ? 2400 : 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("overview?range=7d");
      const region = page.getByRole("region", { name: "연결 서비스", exact: true });
      await expect(region.getByText("95%", { exact: true })).toBeVisible();
      const link = region.getByRole("link", { name: "MCP 상태 열기", exact: true });
      await link.focus();
      await expect(link).toBeFocused();
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
      await expect(region).toHaveScreenshot(`overview-services-${theme}-${width}.png`, {
        animations: "disabled",
        mask: [region.locator(".health-widget-footer time")],
      });
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.writes).toEqual([]);
    });
  }
