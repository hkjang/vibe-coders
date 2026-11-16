import { expect, type Page } from "@playwright/test";
import { test, flowRequestA, flowRequestB, type RequestFlowGateway } from "./fixtures/request-safe-flow";

const left = {
  ...flowRequestA,
  request_id: "req-metric-a",
  request_filterable: true,
  currency: "USD",
  estimated_cost: 0.000123,
  latency_ms: 1000,
  first_chunk_ms: 350,
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
};
const right = {
  ...flowRequestB,
  request_id: "req-metric-b",
  request_filterable: true,
  currency: "USD",
  estimated_cost: 0.000023,
  latency_ms: 1201,
  first_chunk_ms: 300,
  prompt_tokens: 90,
  completion_tokens: 70,
  total_tokens: 160,
};
const response = (rows: (typeof left)[]) => ({
  requests: rows,
  limit: 2,
  generated_at: "2026-10-01T00:00:03Z",
});

async function open(page: Page, gateway: RequestFlowGateway, currency = "USD") {
  gateway.authMode("open");
  gateway.rows([left, { ...right, currency }]);
  gateway.listReply(2, { body: response([left]) });
  gateway.listReply(3, { body: response([{ ...right, currency }]) });
  await page.goto("observability/requests");
  const list = page.getByRole("table");
  await expect(list.getByText("0.000123 USD", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1번째 요청 req-metric-a 상세 보기", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("0.000123 USD", { exact: true })).toBeVisible();
  await page.getByLabel("비교할 요청 ID").fill("req-metric-b");
  await page.getByRole("button", { name: "비교", exact: true }).click();
}

test("목록·상세·비교의 통화를 유지하고 값 차이를 요청 추가 조회 없이 좁힌다", async ({ page, gateway }) => {
  await open(page, gateway);
  const result = page.locator(".request-comparison-result");
  const table = result.getByRole("table");
  await expect(table.getByRole("row", { name: /전체 지연/ })).toContainText("201 ms 증가");
  await expect(table.getByRole("row", { name: /첫 청크 지연/ })).toContainText("50 ms 감소");
  await expect(table.getByRole("row", { name: /추정 비용/ })).toContainText("0.0001 USD 감소");
  await expect(table).not.toContainText("₩");
  await result.getByRole("checkbox", { name: "같은 항목 숨기기" }).check();
  await expect(table.getByRole("row", { name: /캐시 토큰/ })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /입력 토큰/ })).toContainText("10 토큰 감소");
  expect(gateway.listCalls).toHaveLength(3);
  await expect(page.getByRole("status", { name: "요청 비교 요약" })).toContainText("비교 제외 0개");
});

test("다른 통화는 금액과 단위를 보존하고 차액 비교에서 제외한다", async ({ page, gateway }) => {
  await open(page, gateway, "KRW");
  const result = page.locator(".request-comparison-result");
  await expect(result.getByRole("row", { name: /추정 비용/ })).toContainText("통화가 달라 비교 제외");
  await result.getByRole("checkbox", { name: "같은 항목 숨기기" }).check();
  await expect(result.getByRole("row", { name: /추정 비용/ })).toContainText("0.000023 KRW");
  expect(gateway.listCalls).toHaveLength(3);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 비교 요약·변화 표·키보드와 접근성`, async ({ page, gateway }) => {
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await open(page, gateway);
      const result = page.locator(".request-comparison-result");
      const toggle = result.getByRole("checkbox", { name: "같은 항목 숨기기" });
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(toggle).toBeChecked();
      const scroll = result.getByRole("region", { name: "요청 비교 표 가로 스크롤" });
      await page.keyboard.press("Tab");
      await expect(scroll).toBeFocused();
      if (width < 768) {
        await page.keyboard.press("End");
        await scroll.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
        });
        expect(await scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await page.mouse.move(0, 0);
      await expect(result.locator(".request-comparison-summary")).toHaveScreenshot(
        `comparison-summary-${theme}-${width}.png`,
      );
      await expect(scroll).toHaveScreenshot(`comparison-metrics-${theme}-${width}.png`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "1번째 요청 req-metric-a 상세 보기", exact: true }),
      ).toBeFocused();
    });
  }
}
