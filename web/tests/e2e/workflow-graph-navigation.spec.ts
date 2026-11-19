import { expect, type Locator, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { bootstrap, test } from "../fixtures/workflow-ownership-gateway";
import { workflowReadFixture } from "../../src/test/workflow-fixtures";
import type { WorkflowDefinition } from "../../src/shared/api/generated";

const workflow: WorkflowDefinition = {
  id: "wf-long-graph",
  name: "여러 단계 업무",
  description: "긴 연결의 단계 위치를 확인합니다.",
  enabled: false,
  allowed_teams: "운영팀",
  created_by: "operator",
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
  steps: Array.from({ length: 12 }, (_, index) => ({
    id: `step_${index + 1}`,
    name: `업무 단계 ${index + 1}`,
    type: "transform" as const,
  })),
  flow: {
    version: 1,
    entry: "step_1",
    edges: Array.from({ length: 12 }, (_, index) => ({
      from: `step_${index + 1}`,
      to: index === 11 ? "$end" : `step_${index + 2}`,
      when: "next" as const,
    })),
  },
};

async function fixture(page: Page, readOnly = false) {
  const writes: string[] = [];
  await page.clock.setFixedTime(new Date("2026-11-17T12:00:00Z"));
  await page.route("**/admin/ui-bootstrap", (route) =>
    route.fulfill({
      json: { ...bootstrap(readOnly ? "read_only" : "writable"), backend_version: "v0.86.161" },
    }),
  );
  await page.route(/\/admin\/workflows(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    const q = Object.fromEntries(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: q.view === "review" ? { workflow, revision: "a".repeat(64) } : workflowReadFixture([workflow], q),
    });
  });
  await page.goto("agents/workflows?workflow=wf-long-graph");
  const detail = page.getByRole("dialog", { name: workflow.name, exact: true });
  await expect(detail).toBeVisible();
  return { writes, detail };
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`조회 그림의 배율·키보드·선택 위치와 접근성 ${theme}-${width}`, async ({ page, gateway }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const state = await fixture(page, true);
      await expect(state.detail.getByRole("button", { name: "수정", exact: true })).toBeDisabled();
      await state.detail.getByRole("tab", { name: "흐름 보기", exact: true }).click();
      const diagram = state.detail.getByRole("region", { name: "워크플로 분기 연결 그림" });
      await state.detail.getByLabel("그림에서 찾을 단계", { exact: true }).selectOption("step_12");
      const last = diagram.getByRole("button", { name: /^업무 단계 12,/u });
      const first = diagram.getByRole("button", { name: /^업무 단계 1,/u });
      await expectInside(diagram, last);
      await last.focus();
      await page.keyboard.press("Home");
      await expect(first).toBeFocused();
      await expectInside(diagram, first);
      await page.keyboard.press("End");
      await expect(last).toBeFocused();
      await expectInside(diagram, last);
      await page.keyboard.press("Tab");
      expect(await diagram.evaluate((element) => element.contains(document.activeElement))).toBe(false);
      await state.detail.getByRole("button", { name: "전체 보기", exact: true }).click();
      await expect
        .poll(() =>
          diagram.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
          ),
        )
        .toBe(true);
      await page.setViewportSize({ width: Math.max(360, width - 80), height: 1000 });
      await expect
        .poll(() =>
          diagram.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
          ),
        )
        .toBe(true);
      await page.setViewportSize({ width, height: 1000 });
      await state.detail.getByRole("button", { name: "선택 단계 보기", exact: true }).click();
      await expect(state.detail.getByLabel("그림 배율")).toHaveText("100%");
      await expect.poll(async () => (await last.boundingBox())?.width ?? 0).toBeGreaterThan(180);
      await expectInside(diagram, last);
      await diagram.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await state.detail.getByRole("button", { name: "선택 단계 보기", exact: true }).click();
      await expectInside(diagram, last);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (target: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      expect(violations).toEqual([]);
      expect(await state.detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const viewer = state.detail.locator(".workflow-graph-viewer");
      // Locator screenshots may scroll the dialog under the last pointer position.
      // Capture the idle controls after stabilizing the viewer's viewport position.
      await viewer.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await expect.poll(() => viewer.evaluate((element) => element.matches(":hover"))).toBe(false);
      await expect(viewer).toHaveScreenshot(`workflow-graph-navigation-${theme}-${width}.png`);
      expect(state.writes).toEqual([]);
      expect(gateway.writes).toEqual([]);
      expect(gateway.simulations).toEqual([]);
    });
  }

async function expectInside(diagram: Locator, node: Locator) {
  await expect
    .poll(async () => {
      const region = await diagram.boundingBox(),
        box = await node.boundingBox();
      return Boolean(
        region &&
        box &&
        box.x >= region.x &&
        box.y >= region.y &&
        box.x + box.width <= region.x + region.width &&
        box.y + box.height <= region.y + region.height,
      );
    })
    .toBe(true);
}

for (const width of [1440, 390]) {
  test(`단계 선택 후 긴 그림 안의 선택 위치가 보인다 ${width}`, async ({ page, gateway }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    await state.detail.getByRole("button", { name: "수정", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "분기 워크플로 수정", exact: true });
    await dialog.getByLabel("편집할 단계", { exact: true }).selectOption("step_12");
    const diagram = dialog.getByRole("region", { name: "워크플로 분기 연결 그림" });
    await expectInside(diagram, diagram.getByRole("button", { name: /^업무 단계 12,/u }));
    expect(state.writes).toEqual([]);
    expect(gateway.writes).toEqual([]);
    expect(gateway.simulations).toEqual([]);
  });
}
