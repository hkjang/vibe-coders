import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installOverviewWorkspace } from "../fixtures/overview-workspace-browser";

test("운영 신호에서 선택한 기간의 라우팅 상태로 키보드 이동하고 새로고침한다", async ({ page }) => {
  const fixture = await installOverviewWorkspace(page);
  await page.goto("overview?range=7d");
  await expect(page.getByText("₩4,200")).toBeVisible();
  const link = page.getByRole("link", { name: "선택 기간의 라우팅 상태 열기", exact: true });
  await expect(link).toHaveAttribute("href", "/app/routing/rules/health?window=7d&threshold=70");
  await link.focus();
  await link.press("Enter");
  await expect(page).toHaveURL(/routing\/rules\/health\?window=7d&threshold=70$/);
  await expect(page.getByRole("heading", { name: "공급자 상태 점수", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "공급자 상태 점수", exact: true })).toBeVisible();
  expect(fixture.state.routingWindows.every((range) => range === "7d")).toBe(true);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("한 영역의 권한 거부는 정상 영역을 유지하고 명시적 재시도로만 복구한다", async ({ page }) => {
  const fixture = await installOverviewWorkspace(page);
  await page.goto("overview");
  await expect(page.getByText("₩4,200")).toBeVisible();
  fixture.state.denyStats = true;
  await page.getByRole("button", { name: "전체 새로고침", exact: true }).click();
  await expect(page.getByText("₩4,200")).toHaveCount(0);
  await expect(page.getByText("이 작업을 수행할 권한이 없습니다.")).toBeVisible();
  await expect(page.getByText("현재 탐지된 위험 요인이 없습니다.")).toBeVisible();
  const deniedReads = fixture.state.reads["/admin/stats"];
  await page
    .getByRole("group", { name: "조회 기간", exact: true })
    .getByRole("button", { name: "7일", exact: true })
    .click();
  await expect.poll(() => fixture.state.routingWindows.at(-1)).toBe("7d");
  expect(fixture.state.reads["/admin/stats"]).toBe(deniedReads);
  fixture.state.denyStats = false;
  const retry = page.getByRole("button", { name: "보존 트래픽과 비용 재시도", exact: true });
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByText("₩4,200")).toBeVisible();
  expect(fixture.state.reads["/admin/stats"]).toBe((deniedReads ?? 0) + 1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("권한 없는 이동 링크를 숨기고 기존 화면 단계는 등록된 주소로 연결한다", async ({ page }) => {
  const fixture = await installOverviewWorkspace(page);
  fixture.bootstrap.permissions = ["admin:read"];
  if (!fixture.bootstrap.user) throw new Error("Missing fixture identity");
  fixture.bootstrap.user.scopes = fixture.bootstrap.permissions;
  const requests = fixture.bootstrap.migration_registry.find(
    (feature) => feature.feature_id === "observability.requests",
  );
  if (!requests) throw new Error("Missing requests feature");
  requests.status = "hidden";
  const system = fixture.bootstrap.migration_registry.find(
    (feature) => feature.feature_id === "system.health",
  );
  if (!system) throw new Error("Missing system feature");
  system.status = "legacy";
  await page.goto("overview");
  await expect(page.getByText("₩4,200")).toBeVisible();
  await expect(page.getByRole("link", { name: "보존 요청 열기", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "선택 기간의 라우팅 상태 열기", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "시스템 상태 열기 기존 화면", exact: true })).toHaveAttribute(
    "href",
    system.legacy_path,
  );
  expect(fixture.state.routingWindows).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("첫 실행 안내는 운영 설정 조회에 성공한 뒤 권한 있는 기능만 연결한다", async ({ page }) => {
  const fixture = await installOverviewWorkspace(page);
  fixture.state.empty = true;
  fixture.state.failOperations = true;
  await page.goto("overview");
  await expect(page.getByText("요청 ID: overview-fixture")).toBeVisible();
  await expect(page.getByRole("heading", { name: "게이트웨이 시작하기" })).toHaveCount(0);
  fixture.state.failOperations = false;
  await page.getByRole("button", { name: "운영 위험 재시도", exact: true }).click();
  await expect(page.getByRole("heading", { name: "게이트웨이 시작하기" })).toBeVisible();
  await expect(page.getByRole("link", { name: "채팅 테스트 열기", exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 운영 개요 한글·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installOverviewWorkspace(page);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("overview?range=7d");
      await expect(page.getByText("₩4,200")).toBeVisible();
      await expect(page.getByRole("link", { name: "저장소 상태 열기", exact: true })).toBeVisible();
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
      await expect(page).toHaveScreenshot(`overview-workspace-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
