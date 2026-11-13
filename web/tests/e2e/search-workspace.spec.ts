import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSearchWorkspace } from "../fixtures/search-workspace-browser";
import { runtimeKey } from "../fixtures/settings-workspace-browser";

async function openSearch(page: Page) {
  await page.goto("system/settings?tab=runtime");
  await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  return palette;
}
test("자원 종류 선택·같은 검색어 유지·범위별 요청·정확한 상세 연결", async ({ page }) => {
  const fixture = await installSearchWorkspace(page);
  const palette = await openSearch(page),
    input = palette.getByRole("combobox");
  await input.fill("정산");
  await expect(palette.getByRole("option")).toHaveCount(11);
  await expect(palette.getByRole("group", { name: "시스템 설정 1개 · 일부 결과" })).toBeVisible();
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
  const choices = palette.getByRole("group", { name: "검색할 자원 종류" });
  await expect(choices.getByRole("button")).toHaveCount(13);
  await choices.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("정산");
  await expect(palette.getByRole("option")).toHaveCount(1);
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["setting"] });
  await input.press("Enter");
  const detail = page.getByRole("dialog", { name: runtimeKey, exact: true });
  await expect(detail).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
    setting: runtimeKey,
    tab: "runtime",
  });
  await expect(detail.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("키보드로 실패 종류 선택·재시도·전체 복귀·닫은 뒤 입력과 범위 초기화", async ({ page }) => {
  const fixture = await installSearchWorkspace(page);
  const palette = await openSearch(page),
    input = palette.getByRole("combobox");
  await input.fill("정산");
  await expect(palette.getByRole("status")).toContainText("정책 (조회 실패)");
  await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).focus();
  await page.keyboard.press("Enter");
  const choices = palette.getByRole("group", { name: "검색할 자원 종류" });
  for (let i = 0; i < 11; i++) await page.keyboard.press("Tab");
  await expect(choices.getByRole("button", { name: "정책", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toBeFocused();
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(palette.getByRole("status")).toContainText("정책 (조회 실패)");
  fixture.result.failPolicy = false;
  await palette.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(palette.getByRole("option")).toHaveCount(1);
  expect(fixture.searches.at(-1)).toEqual({ query: "정산", kinds: ["policy"] });
  await palette.getByRole("button", { name: "검색 대상: 정책" }).click();
  await choices.getByRole("button", { name: "전체 자원", exact: true }).click();
  await expect(palette.getByRole("option")).toHaveCount(12);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  const count = fixture.searches.length;
  await page.keyboard.press("Control+k");
  await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(palette.getByRole("button", { name: "검색 대상: 전체 자원" })).toBeVisible();
  expect(fixture.searches).toHaveLength(count);
});

test("검색 범위 변경 중 늦은 전체 응답은 선택한 결과를 덮어쓰지 않는다", async ({ page }) => {
  const fixture = await installSearchWorkspace(page);
  fixture.result.holdNext = true;
  const palette = await openSearch(page),
    input = palette.getByRole("combobox");
  try {
    await input.fill("정산");
    await expect.poll(() => fixture.searches.length).toBe(1);
    await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
    await palette
      .getByRole("group", { name: "검색할 자원 종류" })
      .getByRole("button", { name: "시스템 설정", exact: true })
      .click();
    await expect(palette.getByRole("option")).toHaveCount(1);
    fixture.result.release();
    await expect(palette.getByRole("option")).toHaveCount(1);
    await expect(palette.getByRole("option")).toContainText("시스템 설정 정산");
    expect(fixture.searches.at(-1)?.kinds).toEqual(["setting"]);
  } finally {
    fixture.result.release();
  }
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`검색 작업 공간 접근성·시각 ${theme}-${width}`, async ({ page }) => {
      const fixture = await installSearchWorkspace(page);
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const palette = await openSearch(page);
      await palette.getByRole("combobox").fill("정산");
      await expect(palette.getByRole("option")).toHaveCount(11);
      for (const expanded of [false, true]) {
        if (expanded) await palette.getByRole("button", { name: "검색 대상: 전체 자원" }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const violations = await page.evaluate(async () =>
          (
            await (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe.run(
              '[role="dialog"]',
            )
          ).violations.map(({ id }) => id),
        );
        expect(violations).toEqual([]);
        await expect(palette).toHaveScreenshot(
          `search-workspace-${theme}-${width}-${expanded ? "choices" : "results"}.png`,
        );
      }
      const choices = palette.getByRole("group", { name: "검색할 자원 종류" });
      await choices.getByRole("button", { name: "로그인 계정", exact: true }).focus();
      await expect(choices.getByRole("button", { name: "로그인 계정", exact: true })).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(palette.getByRole("combobox")).toBeFocused();
      await expect(palette.getByRole("option")).toHaveCount(1);
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
