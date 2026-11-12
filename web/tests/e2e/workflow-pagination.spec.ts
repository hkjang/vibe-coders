import { expect } from "@playwright/test";
import type axe from "axe-core";
import { test } from "../fixtures/workflow-ownership-gateway";
import { workflowReadFixture } from "../../src/test/workflow-fixtures";
import { watchEditorAssets } from "../fixtures/agent-code-editor";

const rows = Array.from({ length: 137 }, (_, index) => ({
  id: `wf-${String(index).padStart(3, "0")}`,
  name: `업무 자동화 ${String(index).padStart(3, "0")}`,
  description: "업무 조회와 승인 과정을 관리합니다.",
  enabled: index % 2 === 0,
  allowed_teams: "운영팀",
  steps: [{ name: `승인 ${index}`, type: "approval" }],
}));
test.beforeEach(async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  await watchEditorAssets(page);
  await page.route(/\/admin\/workflows(?:\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: workflowReadFixture(rows, Object.fromEntries(new URL(route.request().url()).searchParams)),
        })
      : route.fallback(),
  );
});

test("서버 페이지·검색·상세 주소를 복원하고 키보드 초점을 반환한다", async ({ page }) => {
  const queries: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/workflows") queries.push(url.searchParams);
  });
  await page.goto("agents/workflows?size=10&page=2&sort=id:asc");
  const table = page.getByRole("table", { name: "정의된 워크플로 목록" });
  await expect(table.getByRole("row")).toHaveCount(11);
  const link = table.getByRole("link", { name: "업무 자동화 010 정의 보기" });
  await link.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "업무 자동화 010", exact: true });
  await expect(detail.getByText("승인 10", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(link).toBeFocused();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(table.getByText("업무 자동화 020", { exact: true })).toBeVisible();
  await page.reload();
  await expect(table.getByText("업무 자동화 020", { exact: true })).toBeVisible();
  await page.getByLabel("워크플로 검색", { exact: true }).fill("업무 자동화 136");
  await page.getByRole("button", { name: "검색 적용", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText("업무 자동화 136", { exact: true })).toBeVisible();
  expect(queries.filter((q) => q.get("view") === "page").every((q) => Number(q.get("limit")) === 10)).toBe(
    true,
  );
  expect(queries.some((q) => q.get("view") === "detail" && q.get("id") === "wf-010")).toBe(true);
  expect(queries.some((q) => q.get("q") === "업무 자동화 136" && q.get("offset") === "0")).toBe(true);
});

test("현재 페이지에 없는 상세를 새로고침하고 목록 상태를 유지한다", async ({ page }) => {
  await page.goto("agents/workflows?size=10&page=2&workflow=wf-136");
  await expect(page.getByRole("dialog", { name: "업무 자동화 136", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "업무 자동화 136", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/size=10&page=2$/);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`워크플로 목록 시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("agents/workflows?size=10&sort=id:asc");
      await expect(page.getByRole("table", { name: "정의된 워크플로 목록" }).getByRole("row")).toHaveCount(
        11,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map(
          (item) => item.id,
        ),
      );
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`workflow-pagination-${theme}-${width}.png`, {
        fullPage: true,
        mask: [page.locator(".agents-updated")],
      });
    });
