import { expect, test } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSchemaSearch, searchedSchema } from "../fixtures/text2sql-schema-search-browser";
const direct = "text2sql/schemas/detail?schema_name=" + encodeURIComponent(searchedSchema.name);
test("스키마 이름 검색에서 정확한 상세·직접 새로고침·기존 화면을 연다", async ({ page }) => {
  const fixture = await installSchemaSearch(page);
  await page.goto("system/settings?tab=runtime");
  await page.getByRole("button", { name: "명령 팔레트 열기", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  await palette
    .getByRole("group", { name: "검색할 자원 종류" })
    .getByRole("button", { name: "Text2SQL 스키마", exact: true })
    .click();
  await palette.getByRole("combobox").fill("정산");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await palette.getByRole("combobox").press("Enter");
  await expect(page.getByRole("heading", { name: searchedSchema.name, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("schema_name")).toBe(searchedSchema.name);
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["text2sql_schema"] });
  await page.reload();
  await expect(page.getByText("스키마 설명과 허용 테이블은 비공개입니다.")).toBeVisible();
  await expect(page.getByRole("link", { name: "기존 화면에서 열기", exact: true })).toHaveAttribute(
    "href",
    "/admin#/text2sql",
  );
  await expect(page.getByRole("link", { name: "스키마 목록 열기" })).toHaveAttribute(
    "href",
    "/app/text2sql?tab=schemas",
  );
  expect(fixture.state.names.every((name) => name === searchedSchema.name)).toBe(true);
  expect(fixture.state.names).toHaveLength(2);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("조회 실패 재시도·권한 거부·삭제 상태에서 이전 설명을 숨긴다", async ({ page }) => {
  const fixture = await installSchemaSearch(page);
  fixture.state.failOnce = true;
  await page.goto(direct);
  await expect(page.getByText("요청 ID: schema-detail-fixture")).toBeVisible();
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("heading", { name: searchedSchema.name, exact: true })).toBeVisible();
  fixture.state.deny = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("스키마 조회 권한을 확인하세요.")).toBeVisible();
  await expect(page.getByText(searchedSchema.team)).toHaveCount(0);
  fixture.state.deny = false;
  fixture.state.raw = true;
  await page.getByRole("button", { name: "권한 다시 확인" }).click();
  await page.getByRole("button", { name: "설명 보기" }).click();
  await expect(page.getByLabel("스키마 설명 본문")).toContainText(searchedSchema.schema_text);
  fixture.state.missing = true;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("해당 스키마를 찾을 수 없습니다.")).toBeVisible();
  await expect(page.getByText(searchedSchema.schema_text)).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 스키마 상세 한글·접근성·시각 기준`, async ({ page }) => {
      const fixture = await installSchemaSearch(page);
      fixture.state.raw = true;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto(direct);
      const toggle = page.getByRole("button", { name: "설명 보기" });
      await toggle.focus();
      await toggle.press("Enter");
      await expect(page.getByLabel("스키마 설명 본문")).toContainText(searchedSchema.schema_text);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("body")).toHaveCSS(
        "color",
        theme === "dark" ? "rgb(231, 234, 240)" : "rgb(23, 32, 51)",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
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
      await expect(page).toHaveScreenshot(`schema-detail-${theme}-${width}.png`, {
        animations: "disabled",
        fullPage: true,
      });
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
