import { expect, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { bootstrap, test } from "../fixtures/workflow-ownership-gateway";
import { workflowReadFixture } from "../../src/test/workflow-fixtures";
import type { WorkflowDefinition, WorkflowGraphWriteRequest } from "../../src/shared/api/generated";

const graph: WorkflowDefinition = {
  id: "wf-graph",
  name: "고객 문의 분기",
  description: "입력 조건에 따라 담당 경로를 선택합니다.",
  enabled: false,
  allowed_teams: "운영팀",
  created_by: "operator",
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
  steps: [
    {
      id: "start",
      name: "승인 문구 확인",
      type: "condition",
      condition: { operator: "contains", value: "승인" },
    },
    { id: "review", name: "담당자 검토", type: "transform" },
    { id: "general", name: "일반 문의", type: "transform" },
  ],
  flow: {
    version: 1,
    entry: "start",
    edges: [
      { from: "start", to: "review", when: "true" },
      { from: "start", to: "general", when: "false" },
      { from: "review", to: "$end", when: "next" },
      { from: "general", to: "$end", when: "next" },
    ],
  },
};
async function fixture(page: Page) {
  let current = structuredClone(graph);
  const writes: WorkflowGraphWriteRequest[] = [];
  await page.clock.setFixedTime(new Date("2026-11-17T12:00:00Z"));
  await page.route("**/admin/ui-bootstrap", (route) =>
    route.fulfill({ json: { ...bootstrap("writable"), backend_version: "v0.86.160" } }),
  );
  await page.route(/\/admin\/workflows(?:\?.*)?$/, (route) => {
    const q = Object.fromEntries(new URL(route.request().url()).searchParams);
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as WorkflowGraphWriteRequest;
      writes.push(body);
      current = { ...current, ...body.workflow };
      return route.fulfill({ json: { workflow: current, revision: "b".repeat(64) } });
    }
    return route.fulfill({
      json:
        q.view === "review"
          ? { workflow: current, revision: "a".repeat(64) }
          : workflowReadFixture([current], q),
    });
  });
  return { writes };
}
async function edit(page: Page) {
  await page.goto("agents/workflows?workflow=wf-graph");
  await page
    .getByRole("dialog", { name: graph.name, exact: true })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "분기 워크플로 수정", exact: true });
  await expect(dialog.getByLabel("워크플로 이름", { exact: false })).toHaveValue(graph.name);
  return dialog;
}

test("선택 상자와 키보드 그림으로 분기 편집 후 검토한 정의만 저장한다", async ({ page, gateway }) => {
  const state = await fixture(page);
  const dialog = await edit(page);
  const diagram = dialog.getByRole("region", { name: "워크플로 분기 연결 그림" });
  const target = diagram.getByRole("button", { name: /일반 문의/u });
  await target.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("편집할 단계", { exact: true })).toHaveValue("general");
  await dialog.getByLabel("단계 이름", { exact: true }).fill("일반 문의 처리");
  const save = dialog.getByRole("button", { name: "검토한 정의 저장", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel("변경 사유", { exact: false }).fill("분기 연결 확인");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "저장 전 검토", exact: true })).toBeFocused();
  await dialog.getByLabel("워크플로 이름", { exact: false }).fill("수정한 고객 문의");
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("dialog", { name: "수정한 고객 문의", exact: true })
      .getByRole("button", { name: "수정", exact: true }),
  ).toBeFocused();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    expected_revision: "a".repeat(64),
    reason: "분기 연결 확인",
    workflow: { enabled: false, flow: graph.flow },
  });
  expect(gateway.writes).toEqual([]);
  expect(gateway.simulations).toEqual([]);
});

test("연결 없는 단계는 저장하지 않고 검토 오류로 초점을 옮긴다", async ({ page }) => {
  const state = await fixture(page);
  const dialog = await edit(page);
  await dialog.getByRole("button", { name: "단계 추가", exact: true }).click();
  await dialog.getByLabel("변경 사유", { exact: false }).fill("새 경로");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByText(/시작 단계에서 도달할 수 없는 단계/u)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "검토한 정의 저장", exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`한글 분기 편집 시각·접근성 ${theme}-${width}`, async ({ page }) => {
      const state = await fixture(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const dialog = await edit(page);
      await expect(dialog.getByRole("region", { name: "워크플로 분기 연결 그림" })).toBeVisible();
      const diagram = dialog.getByRole("region", { name: "워크플로 분기 연결 그림" });
      const drawing = await diagram.locator("svg").boundingBox();
      expect(drawing?.width).toBeGreaterThan(400);
      expect(drawing?.height).toBeGreaterThan(200);
      expect((await diagram.boundingBox())?.height).toBeGreaterThan(150);
      const selected = diagram.getByRole("button", { name: /승인 문구 확인/u });
      const selectedColors = await selected.evaluate((element) => {
        const box = element.querySelector("rect");
        const text = element.querySelector("text");
        return {
          background: box && getComputedStyle(box).fill,
          foreground: text && getComputedStyle(text).fill,
        };
      });
      expect(selectedColors.foreground).not.toBe(selectedColors.background);
      const falseLabel = await diagram.getByText("거짓일 때", { exact: true }).boundingBox();
      const branch = await diagram.getByRole("button", { name: /일반 문의/u }).boundingBox();
      expect(falseLabel && branch && falseLabel.x + falseLabel.width + 4 <= branch.x).toBe(true);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (target: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      expect(violations).toEqual([]);
      await dialog.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      await expect(page).toHaveScreenshot(`workflow-graph-editor-${theme}-${width}.png`);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(state.writes).toEqual([]);
    });
  }
