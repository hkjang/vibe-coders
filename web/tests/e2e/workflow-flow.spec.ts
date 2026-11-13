import { expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test } from "../fixtures/workflow-ownership-gateway";
import { workflowReadFixture } from "../../src/test/workflow-fixtures";

const steps = Array.from({ length: 60 }, (_, index) => ({
  name: `업무 단계 ${index + 1}`,
  type: index === 0 ? "condition" : index === 1 ? "chat" : index === 59 ? "__proto__" : "approval",
  ref: index === 1 ? "public-model" : "",
  timeout_ms: 30000,
  max_tokens: 800,
  max_cost_krw: 2.5,
  allowed_tools: ["public-search"],
  allowed_tables: ["public_reports"],
  note: "등록된 업무 단계와 한도를 확인합니다.",
}));
const workflow = {
  id: "wf-flow",
  name: "업무 단계 검토",
  enabled: true,
  allowed_teams: "운영팀",
  description: "저장된 정의의 순서를 확인합니다.",
  steps,
};
test.beforeEach(async ({ page, gateway }) => {
  // Pin Date only; timers, animations and the production CSP remain active.
  await page.clock.setFixedTime(new Date("2026-11-12T12:00:00Z"));
  gateway.setMode("read_only");
  await page.route(/\/admin\/workflows(?:\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: workflowReadFixture(
            [workflow],
            Object.fromEntries(new URL(route.request().url()).searchParams),
          ),
        })
      : route.fallback(),
  );
});

test("읽기 전용 상세에서 키보드로 흐름을 탐색하고 25단계씩 이동한다", async ({ page, gateway }) => {
  await page.goto("agents/workflows?workflow=wf-flow");
  const detail = page.getByRole("dialog", { name: workflow.name, exact: true });
  await expect(detail.getByRole("button", { name: "수정", exact: true })).toBeDisabled();
  await detail.getByRole("tab", { name: "흐름 보기", exact: true }).click();
  const nodes = detail.getByRole("tablist", { name: "단계 흐름", exact: true });
  await expect(nodes.getByRole("tab")).toHaveCount(25);
  await nodes.getByRole("tab").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(nodes.getByRole("tab", { selected: true })).toHaveAccessibleName("2. 업무 단계 2 채팅");
  await expect(detail.getByRole("tabpanel", { name: "2. 업무 단계 2 채팅", exact: true })).toContainText(
    "public-model",
  );
  await detail.getByRole("button", { name: "다음 25단계" }).click();
  await detail.getByRole("button", { name: "다음 25단계" }).click();
  await expect(nodes.getByRole("tab")).toHaveCount(10);
  await expect(detail.getByRole("button", { name: "이전 25단계" })).toBeFocused();
  await expect(nodes.getByRole("tab", { selected: true })).toHaveAccessibleName("51. 업무 단계 51 승인");
  await nodes.getByRole("tab").last().click();
  await expect(nodes.getByRole("tab", { selected: true })).toHaveAccessibleName(
    "60. 업무 단계 60 알 수 없는 종류",
  );
  await detail.getByRole("tab", { name: "표 보기", exact: true }).click();
  await expect(detail.getByRole("table", { name: "워크플로 단계 정의" })).toBeVisible();
  await expect(detail.getByRole("cell", { name: "알 수 없는 종류", exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
  expect(gateway.simulations).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`흐름 조회 시각·접근성 ${theme}-${width}`, async ({ page, gateway }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("agents/workflows?workflow=wf-flow");
      const detail = page.getByRole("dialog", { name: workflow.name, exact: true });
      await detail.getByRole("tab", { name: "흐름 보기", exact: true }).click();
      await detail.getByRole("tab", { name: "2. 업무 단계 2 채팅", exact: true }).click();
      const selected = detail.getByRole("tabpanel", { name: "2. 업무 단계 2 채팅", exact: true });
      await selected.scrollIntoViewIfNeeded();
      await detail.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (target: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`workflow-flow-${theme}-${width}.png`, {
        fullPage: false,
      });
      await page.keyboard.press("Tab");
      expect(await detail.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(gateway.writes).toEqual([]);
      expect(gateway.simulations).toEqual([]);
    });
  }
