import { expect } from "@playwright/test";
import type axe from "axe-core";
import { readFile } from "node:fs/promises";
import { test, firstEmail } from "../fixtures/app-permission-gateway";
import { workAppReadFixture } from "../../src/test/work-app-fixtures";
import { watchEditorAssets } from "../fixtures/agent-code-editor";

const rows = Array.from({ length: 137 }, (_, index) => ({
  id: `app-${String(index).padStart(3, "0")}`,
  title: `업무 도우미 ${String(index).padStart(3, "0")}`,
  description: "업무 조회와 승인 과정을 관리합니다.",
  status: index % 2 === 0 ? "active" : "archived",
  allowed_teams: "운영팀",
  components: [{ label: `질문 ${index}`, kind: "prompt", ref: `public-prompt-${index}` }],
}));
test.beforeEach(async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  await watchEditorAssets(page);
  await page.clock.setFixedTime(new Date("2026-11-13T00:00:00Z"));
  await page.route(/\/admin\/apps(?:\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: workAppReadFixture(rows, Object.fromEntries(new URL(route.request().url()).searchParams)),
        })
      : route.fallback(),
  );
  await page.goto("login?return_to=%2Fapp%2Fagents%2Fapps");
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 업무 앱", exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
});

test("서버 페이지·검색·상세 주소를 복원하고 키보드 초점을 반환한다", async ({ page }) => {
  const queries: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/apps") queries.push(url.searchParams);
  });
  await page.goto("agents/apps?size=10&page=2&sort=id:asc");
  const table = page.getByRole("table", { name: "AI 업무 앱 목록" });
  await expect(table.getByRole("row")).toHaveCount(11);
  const link = table.getByRole("link", { name: "업무 도우미 010 상세 보기" });
  await link.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "업무 도우미 010", exact: true });
  await expect(detail.getByText("질문 10", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(link).toBeFocused();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(table.getByText("업무 도우미 020", { exact: true })).toBeVisible();
  await page.reload();
  await expect(table.getByText("업무 도우미 020", { exact: true })).toBeVisible();
  await page.getByLabel("업무 앱 검색", { exact: true }).fill("업무 도우미 136");
  await page.getByRole("button", { name: "검색 적용", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText("업무 도우미 136", { exact: true })).toBeVisible();
  expect(queries.filter((q) => q.get("view") === "page").every((q) => Number(q.get("limit")) === 10)).toBe(
    true,
  );
  expect(queries.some((q) => q.get("view") === "detail" && q.get("id") === "app-010")).toBe(true);
  expect(queries.some((q) => q.get("q") === "업무 도우미 136" && q.get("offset") === "0")).toBe(true);
});

test("현재 페이지에 없는 상세를 새로고침하고 목록 상태를 유지한다", async ({ page }) => {
  await page.goto("agents/apps?size=10&page=2&app=app-136");
  await expect(page.getByRole("dialog", { name: "업무 도우미 136", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "업무 도우미 136", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/size=10&page=2$/);
});

test("내보내기는 현재 페이지만 포함하고 수식과 구성 요소 본문을 보호한다", async ({ page }) => {
  await page.route(/\/admin\/apps(?:\?.*)?$/u, (route) =>
    route.fulfill({
      json: workAppReadFixture(
        rows.map((row, index) => (index === 25 ? { ...row, title: "=SUM(1,1)" } : row)),
        Object.fromEntries(new URL(route.request().url()).searchParams),
      ),
    }),
  );
  await page.goto("agents/apps?page=2&sort=id:asc");
  await expect(page.getByRole("table", { name: "AI 업무 앱 목록" }).getByRole("row")).toHaveCount(26);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "현재 페이지 CSV", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("work-apps-page.csv");
  const path = await file.path();
  if (!path) throw new Error("CSV download missing");
  const content = await readFile(path, "utf8");
  expect(content.trim().split("\r\n")).toHaveLength(26);
  expect(content).toContain("app-025");
  expect(content).toContain("app-049");
  expect(content).toContain("'=SUM(1,1)");
  expect(content).not.toMatch(/app-024|app-050|public-prompt-/u);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`업무 앱 목록 시각 기준 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("agents/apps?size=10&sort=id:asc");
      await expect(page.getByRole("table", { name: "AI 업무 앱 목록" }).getByRole("row")).toHaveCount(11);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map(
          (item) => item.id,
        ),
      );
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`work-app-pagination-${theme}-${width}.png`, {
        fullPage: true,
      });
    });
