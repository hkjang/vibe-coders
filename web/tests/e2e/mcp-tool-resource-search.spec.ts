import { expect, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { bootstrap, test } from "../fixtures/mcp-upstream-gateway";

const tool = "정산/조회&결과";
const servers = ["회계 서버/a&b", "업무 서버"] as const;
async function install(page: Page, failOnce = false) {
  const data = bootstrap("read_only");
  data.backend_version = "v0.86.96";
  const searches: unknown[] = [];
  await page.route("**/admin/ui-bootstrap", (route) => route.fulfill({ json: data }));
  await page.route("**/admin/resource-search", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    searches.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        request_id: "tool-search-fixture",
        groups: [
          {
            kind: "mcp_tool",
            status: failOnce && searches.length === 1 ? "unavailable" : "ok",
            limited: false,
            items:
              failOnce && searches.length === 1
                ? []
                : servers.map((server_label) => ({ kind: "mcp_tool", id: tool, title: tool, server_label })),
          },
        ],
      },
    });
  });
  for (const name of ["tools", "servers", "catalog", "trust-scores"]) {
    await page.route(`**/admin/mcp/${name}?*`, (route) => {
      expect(route.request().method()).toBe("GET");
      const url = new URL(route.request().url());
      const server = url.searchParams.get("server") ?? "";
      if (name === "tools")
        return route.fulfill({ json: { tools: [], tool_risk: [], risk_profiles: [], count: 0 } });
      if (name === "servers") return route.fulfill({ json: { servers: [] } });
      if (name === "trust-scores") return route.fulfill({ json: { tools: [] } });
      return route.fulfill({
        json: {
          catalog: [tool, "선택하지 않은 도구"].map((tool_name) => ({
            server_label: server,
            tool_name,
            is_mcp: true,
            first_seen: "2026-11-13T00:00:00Z",
            last_seen: "2026-11-13T00:00:00Z",
            is_new: true,
            is_stale: false,
          })),
          new_count: 2,
        },
      });
    });
  }
  return searches;
}
async function openSearch(page: Page) {
  await page.goto("mcp?tab=upstreams");
  await expect(page.getByRole("heading", { name: "MCP 운영", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await dialog.getByRole("button", { name: "자원 검색", exact: true }).click();
  const input = dialog.getByRole("combobox", { name: "자원 이름 검색" });
  await expect(input).toBeFocused();
  await input.fill("정산");
  return dialog;
}

test("도구 이름 검색은 키보드·새로고침·뒤로 이동에서 서버와 도구를 보존한다", async ({ page, gateway }) => {
  const searches = await install(page);
  const dialog = await openSearch(page);
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(dialog.getByRole("option", { name: /회계 서버/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /업무 서버/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", { name: "MCP 도구 카탈로그" });
  await expect(table.getByRole("cell", { name: tool, exact: true })).toBeVisible();
  await expect(table).not.toContainText("선택하지 않은 도구");
  await expect(page.getByText("신규 1개", { exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    tab: "tools",
    server: servers[1],
    tool,
    mcp_only: "1",
  });
  expect(searches).toEqual([{ query: "정산", kinds: ["mcp_upstream", "mcp_tool"] }]);
  await page.reload();
  await expect(table.getByRole("cell", { name: tool, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/tab=upstreams$/);
  await page.goForward();
  await expect(table.getByRole("cell", { name: tool, exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("도구 검색 부분 실패는 수동 재시도 후 같은 서버의 도구를 연다", async ({ page, gateway }) => {
  const searches = await install(page, true);
  const dialog = await openSearch(page);
  await expect(dialog.getByRole("status")).toContainText("일부 종류");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "MCP 도구 카탈로그" })).toContainText(servers[0]);
  expect(new URL(page.url()).searchParams.get("server")).toBe(servers[0]);
  expect(searches).toHaveLength(2);
  expect(gateway.writes).toEqual([]);
});

test("긴 서버·도구 이름도 좁은 검색창 안에서 줄바꿈된다", async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 390, height: 800 });
  const longTool = "정산조회".repeat(50);
  const serverLabel = "공유 서버 ".repeat(60).trim();
  await page.route("**/admin/resource-search", (route) =>
    route.fulfill({
      json: {
        request_id: "long-tool-search",
        groups: [
          {
            kind: "mcp_tool",
            status: "ok",
            limited: false,
            items: [{ kind: "mcp_tool", id: longTool, title: longTool, server_label: serverLabel }],
          },
        ],
      },
    }),
  );
  const dialog = await openSearch(page);
  const option = dialog.getByRole("option");
  await expect(option).toContainText(longTool);
  await expect(option).toContainText(serverLabel);
  expect(await option.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await dialog.getByRole("listbox").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`서버별 도구 검색 시각·접근성 ${theme}-${width}`, async ({ page, gateway }) => {
      await install(page);
      await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const dialog = await openSearch(page);
      await expect(dialog.getByRole("option")).toHaveCount(2);
      await dialog.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((a) => a.finished));
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (selector: string) => Promise<AxeResults> } }).axe;
        return (await axe.run('[role="dialog"]')).violations.map(({ id }) => id);
      });
      expect(violations).toEqual([]);
      await expect(page).toHaveScreenshot(`mcp-tool-search-${theme}-${width}.png`);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      expect(gateway.writes).toEqual([]);
    });
  }
