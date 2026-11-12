import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import { installDefinitionEditor } from "../fixtures/golden-definition-browser";

async function setup(page: Page) {
  const fixture = await installDefinitionEditor(page, true);
  await page.goto("prompts/regression");
  const table = page.getByRole("table", { name: "기준 프롬프트 목록" });
  const row = table
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "한글 답변 확인", exact: true }) });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "한글 답변 확인 상세 보기", exact: true });
  return { ...fixture, table, row, button, cell: row.getByRole("cell").nth(1) };
}

test("행 메뉴 자산은 조작 후에만 요청하며 지연 중 다른 입력으로 이동하면 열리지 않는다", async ({ page }) => {
  const assets: string[] = [];
  page.on("request", (r) => {
    if (/\/TableRowMenu-[^/]+\.js$/u.test(new URL(r.url()).pathname)) assets.push(r.url());
  });
  const f = await setup(page);
  expect(assets).toEqual([]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/TableRowMenu-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("status").filter({ hasText: "행 메뉴를 불러오는 중" })).toBeVisible();
  const search = page.getByRole("textbox", { name: "이름·태그 검색", exact: true });
  await search.click();
  const response = page.waitForResponse((r) => /\/TableRowMenu-[^/]+\.js$/u.test(new URL(r.url()).pathname));
  release();
  await (await response).finished();
  await expect(search).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  expect(assets).toHaveLength(1);
  expect(f.writes).toEqual([]);
  f.check();
});

test("메뉴 자산 실패 뒤에도 목록과 명시적 상세 버튼을 사용할 수 있다", async ({ page }) => {
  const f = await setup(page);
  await page.route("**/assets/TableRowMenu-*.js", (route) => route.abort("failed"));
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("status").filter({ hasText: "행 메뉴를 불러오지 못했습니다" })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await f.button.click();
  await expect(page.getByRole("dialog", { name: "기준 프롬프트 상세", exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
  f.check();
});

test("Tab은 행 메뉴를 닫고 다음 조작으로 이동하며 스크롤 뒤 메뉴가 남지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  const f = await setup(page);
  await f.button.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(f.button).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.move(600, 100);
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(f.writes).toEqual([]);
  f.check();
});

test("행 오른쪽 클릭은 읽기 전용 상세를 열고 닫을 때 기존 버튼으로 초점을 돌린다", async ({ page }) => {
  const f = await setup(page);
  await f.cell.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "행 작업" });
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await menu.getByRole("menuitem", { name: "한글 답변 확인 상세 보기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "기준 프롬프트 상세", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("안녕하세요라고 답하세요.", { exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(f.button).toBeFocused();
  expect(f.writes).toEqual([]);
  f.check();
});

test("링크·선택한 텍스트는 기본 메뉴를 유지하고 바깥 클릭은 새 초점을 보존한다", async ({ page }) => {
  const f = await setup(page);
  const link = f.row.getByRole("link", { name: "한글 답변 확인", exact: true });
  await link.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(
    await link.evaluate((el) =>
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    ),
  ).toBe(true);
  await f.cell.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  const search = page.getByRole("textbox", { name: "이름·태그 검색", exact: true });
  await search.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(search).toBeFocused();
  expect(f.writes).toEqual([]);
  f.check();
});

test("조회 권한 회수는 열린 행 메뉴와 이전 상세 진입을 제거한다", async ({ page }) => {
  const f = await setup(page);
  await f.cell.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  f.bootstrap.allowed_features = [];
  f.bootstrap.permissions = [];
  f.bootstrap.migration_registry = f.bootstrap.migration_registry.map((feature) => ({
    ...feature,
    available: false,
    availability_reason: "missing_permission",
  }));
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(f.table).toHaveCount(0);
  expect(f.writes).toEqual([]);
  f.check();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`행 메뉴 ${theme} ${width}px 키보드·접근성·화면`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const f = await setup(page);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await f.button.focus();
      await page.keyboard.press("Shift+F10");
      const menu = page.getByRole("menu", { name: "행 작업" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toBeFocused();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error("Menu bounds unavailable");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(845);
      const violations = await page.evaluate(async () => {
        return (await (window as unknown as { axe: typeof axe }).axe.run(document)).violations.map((v) => ({
          id: v.id,
          count: v.nodes.length,
        }));
      });
      expect(violations).toEqual([]);
      await expect(menu).toHaveScreenshot(`table-menu-${theme}-${width}.png`, { animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(f.button).toBeFocused();
      await page.keyboard.press("ContextMenu");
      await expect(menu).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "기준 프롬프트 상세", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(f.button).toBeFocused();
      expect(f.writes).toEqual([]);
      f.check();
    });
  }
}
