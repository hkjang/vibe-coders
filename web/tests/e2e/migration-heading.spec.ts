import { expect, type Page } from "@playwright/test";
import { test, account } from "./fixtures/text2sql-emergency";

// Synthetic bootstrap/API responses verify presentation and the existing route
// guard, not production promotion, server authorization or operational acceptance.
async function login(page: Page) {
  await page.goto("/app/text2sql");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Text2SQL", exact: true })).toBeVisible();
}
async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
const heading = (page: Page) => page.getByRole("status", { name: "화면 전환 상태", exact: true });
const header = (page: Page) => page.locator("header.page-header");

test("제목의 전환 상태와 읽기 전용은 서버 설정 변경·새로고침에 일치한다", async ({ page, emergency }) => {
  await login(page);
  await expect(heading(page)).toHaveText("미리보기");
  await expect(header(page).getByText("읽기 전용", { exact: true })).toHaveCount(0);
  emergency.readonly(true);
  await refreshRuntime(page);
  await expect(heading(page)).toHaveText("미리보기");
  await expect(header(page).getByText("읽기 전용", { exact: true })).toHaveCount(1);
  emergency.readonly(false);
  emergency.migrationStatus("preview_read_only");
  await refreshRuntime(page);
  await expect(heading(page)).toHaveText("읽기 전용 미리보기");
  await expect(header(page).getByText("읽기 전용", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Text2SQL 처리 중지 검토", exact: true })).toBeDisabled();
  await page.reload();
  await expect(heading(page)).toHaveText("읽기 전용 미리보기");
  emergency.migrationStatus("preview");
  await refreshRuntime(page);
  await expect(heading(page)).toHaveText("미리보기");
  await expect(header(page).getByText("읽기 전용", { exact: true })).toHaveCount(0);
  expect(emergency.writes).toEqual([]);
});

test("기존 화면으로 되돌리면 신규 제목 대신 기존 화면 연결을 제공한다", async ({ page, emergency }) => {
  await login(page);
  emergency.migrationStatus("legacy");
  await refreshRuntime(page);
  await expect(heading(page)).toHaveCount(0);
  await expect(page.getByText("이 기능은 안정 운영 화면에서 제공됩니다.")).toBeVisible();
  await expect(page.getByRole("link", { name: /기존 화면에서 자연어 SQL 운영 열기/ })).toHaveAttribute(
    "href",
    "/admin#/text2sql",
  );
  expect(emergency.writes).toEqual([]);
});

test("조회 실패 제목도 미리보기 상태를 유지하며 기존 화면으로 잘못 표시하지 않는다", async ({
  page,
  emergency,
}) => {
  emergency.failOverview(true);
  await login(page);
  await expect(
    page.getByText("서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.", { exact: true }),
  ).toBeVisible();
  await expect(heading(page)).toHaveText("미리보기");
  await expect(header(page).getByRole("link", { name: "기존 화면에서 열기", exact: true })).toHaveAttribute(
    "href",
    "/admin#/text2sql",
  );
  expect(emergency.writes).toEqual([]);
});

test("390px 다크 제목의 한글 상태·읽기 전용·기존 화면 링크는 접근성과 너비를 유지한다", async ({
  page,
  emergency,
}, info) => {
  emergency.migrationStatus("preview_read_only");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await expect(heading(page)).toHaveText("읽기 전용 미리보기");
  await expect(header(page).getByText("읽기 전용", { exact: true })).toHaveCount(1);
  const legacy = header(page).getByRole("link", { name: "기존 화면에서 열기", exact: true });
  await legacy.focus();
  await expect(legacy).toBeFocused();
  for (const control of [
    legacy,
    header(page).getByRole("button", { name: "새로고침", exact: true }),
    page.getByRole("button", { name: "Text2SQL 처리 중지 검토", exact: true }),
  ]) {
    // Horizontal overflow alone misses Korean labels squeezed into vertical
    // one-character columns. These short action labels must fit on one line.
    expect(
      await control.evaluate((element) => {
        const tops = new Set<number>();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
        }
        return tops.size;
      }),
    ).toBe(1);
  }
  expect(await header(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate(async () => {
      const engine = (
        window as Window & { axe?: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      if (!engine) throw new Error("Accessibility engine missing");
      return (await engine.run(document)).violations.map(({ id }) => id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("migration-heading-mobile-dark.png") });
  expect(emergency.writes).toEqual([]);
});
