import type { AxeResults } from "axe-core";
import { expect, test } from "@playwright/test";
import { installPersonalConsole } from "../fixtures/personal-console-browser";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 1024, 768, 390]) {
    test(`내 할 일은 ${theme} ${width}px에서 내용과 작업을 촘촘하게 배치한다`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await installPersonalConsole(page);
      fixture.state.actions = [
        {
          type: "key_expiry",
          severity: "high",
          message: "곧 만료되는 API 키가 있습니다.",
          button_label: "키 확인",
        },
        {
          type: "failure_increase",
          severity: "warn",
          message: "지난주보다 오류가 늘었습니다. 최근 실패한 요청을 확인하세요.",
          button_label: "오류 요청 확인",
        },
        {
          type: "cost_increase",
          severity: "info",
          message: "비용이 늘었습니다. 사용량과 모델별 비용을 확인하세요.",
          button_label: "리포트 확인",
        },
      ];
      await page.goto("me");
      const card = page
        .getByRole("heading", { name: "내 할 일", exact: true })
        .locator("xpath=ancestor::section[1]");
      await expect(card.getByRole("button", { name: "7일 숨기기", exact: true })).toHaveCount(3);
      const bounds = await card.evaluate((element) => {
        const heading = element.querySelector("header p");
        const first = element.querySelector("li");
        if (!heading || !first) throw new Error("Task heading and first row are required");
        const header = heading.getBoundingClientRect();
        const rows = [...element.querySelectorAll("li")];
        return {
          gap: first.getBoundingClientRect().top - header.bottom,
          rows: rows.map((row) => ({ width: row.clientWidth, scroll: row.scrollWidth })),
        };
      });
      expect(
        bounds.gap,
        "제목과 목록 사이에 카드 높이 때문에 큰 빈 공간이 생기지 않아야 합니다",
      ).toBeLessThanOrEqual(24);
      for (const row of bounds.rows) expect(row.scroll).toBeLessThanOrEqual(row.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
                document,
              )
            ).violations,
        ),
      ).toEqual([]);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: info.outputPath("personal-actions-card.png") });
      await page.screenshot({ path: info.outputPath("personal-actions.png"), fullPage: true });
      await card.getByRole("button", { name: "7일 숨기기", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "할 일 숨기기", exact: true });
      await expect(dialog).toContainText("곧 만료되는 API 키");
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      await expect(card.getByRole("button", { name: "7일 숨기기", exact: true }).first()).toBeFocused();
      await card.getByRole("button", { name: "오류 요청 확인", exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("request_status")).toBe("error");
      expect(fixture.writes).toEqual([]);
      fixture.check();
    });
  }
}

test("할 일이 한 건이어도 알림 카드 높이가 제목과 목록의 간격을 늘리지 않는다", async ({ page }, info) => {
  const fixture = await installPersonalConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("me");
  const card = page
    .getByRole("heading", { name: "내 할 일", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(card.getByRole("button", { name: "키 확인", exact: true })).toBeVisible();
  await expect(page.getByText("새 추천을 확인하세요.", { exact: false })).toBeVisible();
  const gap = await card.evaluate((element) => {
    const header = element.querySelector("header p"),
      first = element.querySelector("li");
    if (!header || !first) throw new Error("Task content must be loaded");
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    }
    throw new Error("Task row must contain visible text");
  });
  expect(gap).toBeLessThanOrEqual(32);
  await card.screenshot({ path: info.outputPath("single-task-card.png") });
  fixture.check();
});

test("긴 할 일과 동작명도 글자 확대에서 읽고 실행할 수 있다", async ({ page }, info) => {
  const fixture = await installPersonalConsole(page, true);
  fixture.state.actions[0] = {
    type: "key_expiry",
    severity: "high",
    message: "공백없는긴운영메시지".repeat(12),
    button_label: "만료예정인연결설정과키상태확인",
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("me");
  const card = page
    .getByRole("heading", { name: "내 할 일", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(card.getByRole("button", { name: "7일 숨기기", exact: true })).toBeDisabled();
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "20px";
  });
  await expect(card.getByText(fixture.state.actions[0].message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = card.getByRole("listitem");
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await card.screenshot({ path: info.outputPath("long-task-card.png") });
  await card.getByRole("button", { name: fixture.state.actions[0].button_label, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("keys");
  expect(fixture.writes).toEqual([]);
  fixture.check();
});

test("새 종류의 할 일도 한글 제목과 원래 설명을 표시한다", async ({ page }) => {
  const fixture = await installPersonalConsole(page);
  fixture.state.actions = [
    { type: "constructor", severity: "info", message: "새 운영 신호를 확인하세요.", button_label: "확인" },
  ];
  await page.goto("me");
  const card = page
    .getByRole("heading", { name: "내 할 일", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(card.getByRole("heading", { name: "운영 신호 확인", exact: true })).toBeVisible();
  await expect(card.getByText("새 운영 신호를 확인하세요.", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  fixture.check();
});
