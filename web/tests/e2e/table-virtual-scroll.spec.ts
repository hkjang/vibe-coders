import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/mcp-upstream-gateway";
import type { AxeResults } from "axe-core";
import { expectCellBoundaries } from "../fixtures/table-cell-boundaries";
import { expectReadableTableText } from "../fixtures/table-text-readability";

async function tools(page: Page, count = 200) {
  const rows = Array.from({ length: count }, (_, index) => ({
    server_label: "공개 합성 서버",
    tool_name: `공개 도구 ${String(index + 1).padStart(3, "0")}`,
    access_class: "read",
    risk_level: "low",
    action: "allow",
    recommended_action: "allow",
    configured: false,
    note: "",
  }));
  const reads: string[] = [];
  await page.route("**/admin/mcp/tools?*", (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    expect(url.searchParams.get("limit")).toBe("200");
    reads.push(url.search);
    const filter = url.searchParams.get("tool");
    const selected = rows.filter((row) => !filter || row.tool_name === filter);
    return route.fulfill({
      json: { tools: [], tool_risk: selected, risk_profiles: [], count: selected.length },
    });
  });
  for (const name of ["servers", "catalog", "trust-scores"]) {
    await page.route(`**/admin/mcp/${name}**`, (route) =>
      route.fulfill({ json: { tools: [], servers: [], catalog: [], new_count: 0 } }),
    );
  }
  return { rows, reads };
}

test("200개 도구의 표는 표시 구간만 렌더링하고 마지막 행까지 이동한다", async ({ page, gateway }, info) => {
  const fixture = await tools(page);
  await page.goto("mcp?tab=tools");
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.getByText("공개 도구 001", { exact: true })).toBeVisible();
  const measurements = await table.evaluate((element) => ({
    rows: element.querySelectorAll("tbody tr[data-table-row-index]").length,
    height: element.getBoundingClientRect().height,
    documentNodes: document.querySelectorAll("*").length,
  }));
  await info.attach("large-table-metrics", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  });
  await expect.poll(() => table.locator("tbody tr[data-table-row-index]").count()).toBeLessThan(70);
  await expect(table).toHaveAttribute("aria-rowcount", "201");
  const scroll = table.locator("..");
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(table.getByText("공개 도구 200", { exact: true })).toBeVisible();
  await expect(table.locator('tr[data-table-row-index="199"]')).toHaveAttribute("aria-rowindex", "201");
  expect(await table.locator("tbody tr[data-table-row-index]").count()).toBeLessThan(70);
  expect(fixture.reads).toHaveLength(1);
  expect(gateway.writes).toEqual([]);
  expect(gateway.unexpected).toEqual([]);
});

test("100개 이하의 목록은 기존 표를 유지하고 가상 행 코드를 내려받지 않는다", async ({ page, gateway }) => {
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/VirtualTableBody-")) chunks.push(request.url());
  });
  await tools(page, 100);
  await page.goto("mcp?tab=tools");
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.locator("tr[data-table-row-index]")).toHaveCount(100);
  await expect(table).not.toHaveAttribute("aria-rowcount");
  expect(chunks).toEqual([]);
  expect(gateway.writes).toEqual([]);
});

test("키보드로 렌더링 경계를 넘어 이동하고 편집을 닫으면 같은 도구로 돌아온다", async ({ page, gateway }) => {
  await tools(page);
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/ToolRiskDialog-")) chunks.push(request.url());
  });
  await page.goto("mcp?tab=tools");
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  const first = table.getByRole("button", {
    name: "공개 합성 서버 공개 도구 001 위험 등급 편집",
    exact: true,
  });
  await first.focus();
  for (let index = 0; index < 60; index++) await page.keyboard.press("Tab");
  const target = table.getByRole("button", {
    name: "공개 합성 서버 공개 도구 061 위험 등급 편집",
    exact: true,
  });
  await expect(target).toBeFocused();
  expect(chunks).toEqual([]);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "도구 위험 등급", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/공개 도구 061의 변경 전후/)).toBeVisible();
  expect(chunks).toHaveLength(1);
  await page
    .locator(".data-table-scroll-virtual")
    .first()
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  const underlyingTable = page.getByRole("table", {
    name: "MCP 도구 위험 등급",
    exact: true,
    includeHidden: true,
  });
  await expect(underlyingTable.getByText("공개 도구 200", { exact: true })).toBeAttached();
  await expect(
    underlyingTable.getByRole("button", {
      name: "공개 합성 서버 공개 도구 061 위험 등급 편집",
      exact: true,
      includeHidden: true,
    }),
  ).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(target).toBeFocused();
  expect(await table.locator("tr[data-table-row-index]").count()).toBeLessThan(70);
  expect(gateway.writes).toEqual([]);
});

test("마지막 행에서 필터를 좁히면 해당 도구만 남는다", async ({ page, gateway }) => {
  const fixture = await tools(page);
  await page.goto("mcp?tab=tools");
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.getByText("공개 도구 001", { exact: true })).toBeVisible();
  await table.locator("..").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(table.getByText("공개 도구 200", { exact: true })).toBeVisible();
  await page.getByLabel("도구 이름", { exact: true }).fill("공개 도구 137");
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(table.getByText("공개 도구 137", { exact: true })).toBeVisible();
  await expect(table.locator("tr[data-table-row-index]")).toHaveCount(1);
  await expect(table).not.toHaveAttribute("aria-rowcount");
  await expect(page).toHaveURL(/tool=/);
  expect(fixture.reads).toHaveLength(2);
  expect(gateway.writes).toEqual([]);
});

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`긴 내용과 글자 확대에도 셀 경계를 유지한다 ${width}px ${theme}`, async ({
      page,
      gateway,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await tools(page);
      const [longTool, longServer] = fixture.rows;
      if (!longTool || !longServer) throw new Error("The 200-row fixture is incomplete");
      longTool.tool_name = "긴_공개_도구_이름_".repeat(22);
      longServer.server_label = "공개 합성 서버 설명 ".repeat(12);
      await page.goto("mcp?tab=tools");
      const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
      await expect(table.getByText(longTool.tool_name, { exact: true })).toBeVisible();
      await expectCellBoundaries(table);
      await expectReadableTableText(table);
      await page.screenshot({ path: info.outputPath(`virtual-table-${theme}-${width}.png`), fullPage: true });
      await expect(page).toHaveScreenshot(`virtual-tool-table-${theme}-${width}.png`, { fullPage: true });
      const violations = await page.evaluate(async () =>
        (
          await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
            document,
          )
        ).violations.map(({ id }) => id),
      );
      expect(violations).toEqual([]);
      await page.addStyleTag({ content: "html { font-size: 20px; }" });
      await expectReadableTableText(table);
      await expectCellBoundaries(table);
      const disclosure = table.getByText(longTool.tool_name, { exact: true }).locator("..");
      const firstRow = disclosure.locator("xpath=ancestor::tr");
      expect((await firstRow.boundingBox())?.height ?? 0).toBeLessThan(130);
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure.locator("..")).toHaveAttribute("open", "");
      await expect.poll(async () => (await firstRow.boundingBox())?.height ?? 0).toBeGreaterThan(130);
      await expect
        .poll(() =>
          table.locator("tr[data-table-row-index]").evaluateAll((rows) => {
            const boxes = rows.map((row) => ({
              index: row.getAttribute("data-table-row-index"),
              top: row.getBoundingClientRect().top,
              bottom: row.getBoundingClientRect().bottom,
            }));
            return boxes.filter(
              (row, index) => index > 0 && row.top < (boxes[index - 1]?.bottom ?? -Infinity) - 1,
            );
          }),
        )
        .toEqual([]);
      await page.keyboard.press("Enter");
      await expect(disclosure.locator("..")).not.toHaveAttribute("open");
      await expect.poll(async () => (await firstRow.boundingBox())?.height ?? Infinity).toBeLessThan(130);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await table.locator("..").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(table.getByText("공개 도구 200", { exact: true })).toBeVisible();
      expect(gateway.writes).toEqual([]);
    });
  }
}

test("가상 행 다운로드 오류는 명확한 새로고침 동작을 제공한다", async ({ page, gateway }) => {
  await tools(page);
  await page.route("**/VirtualTableBody-*.js", (route) => route.abort());
  await page.goto("mcp?tab=tools");
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.getByText("목록을 표시하지 못했습니다. 화면을 새로고침해 주세요.")).toBeVisible();
  await page.unroute("**/VirtualTableBody-*.js");
  await table.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(table.getByText("공개 도구 001", { exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

for (const kind of ["risk", "upstream"] as const) {
  test(`${kind} 편집 코드는 클릭 후에만 내려받고 취소 뒤 늦게 열리지 않는다`, async ({ page, gateway }) => {
    if (kind === "risk") await tools(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const pattern = kind === "risk" ? "**/ToolRiskDialog-*.js" : "**/UpstreamFormDialog-*.js";
    await page.route(pattern, async (route) => {
      requests++;
      await held;
      await route.continue();
    });
    try {
      await page.goto(`mcp?tab=${kind === "risk" ? "tools" : "upstreams"}`);
      const trigger = page.getByRole("button", {
        name: kind === "risk" ? "공개 합성 서버 공개 도구 001 위험 등급 편집" : "업스트림 등록",
        exact: true,
      });
      await expect(trigger).toBeVisible();
      expect(requests).toBe(0);
      await trigger.click();
      const loading = page.getByRole("dialog");
      await expect(loading.getByText("편집 화면을 불러오는 중입니다.")).toBeVisible();
      await expect.poll(() => requests).toBe(1);
      await page.keyboard.press("Escape");
      await expect(loading).toHaveCount(0);
      await expect(trigger).toBeFocused();
      const response = page.waitForResponse((response) =>
        response.url().includes(kind === "risk" ? "/ToolRiskDialog-" : "/UpstreamFormDialog-"),
      );
      release();
      await (await response).finished();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await trigger.click();
      await expect(
        page.getByRole("dialog").getByLabel(kind === "risk" ? "메모" : "표시 이름*", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(gateway.writes).toEqual([]);
    } finally {
      release();
    }
  });
}

test("편집 코드가 늦어도 조회 권한을 잃은 화면에 다시 열리지 않는다", async ({ page, gateway }) => {
  await tools(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ToolRiskDialog-*.js", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto("mcp?tab=tools");
    await page
      .getByRole("button", { name: "공개 합성 서버 공개 도구 001 위험 등급 편집", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByText("편집 화면을 불러오는 중입니다.")).toBeVisible();
    gateway.setMode("no_read");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true })).toHaveCount(0);
    const response = page.waitForResponse((response) => response.url().includes("/ToolRiskDialog-"));
    release();
    await (await response).finished();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(gateway.writes).toEqual([]);
  } finally {
    release();
  }
});
