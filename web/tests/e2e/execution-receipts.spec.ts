import { expect, test, type BrowserContext } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { bootstrap } from "../fixtures/workflow-ownership-gateway";
import { workflowReadFixture } from "../../src/test/workflow-fixtures";
import { workAppReadFixture } from "../../src/test/work-app-fixtures";

type Kind = "app" | "workflow";
const title = (kind: Kind) => (kind === "app" ? "업무 앱 실행 영수증" : "워크플로 실행 영수증");
async function gateway(context: BrowserContext, kind: Kind, failOnce = false) {
  const data = bootstrap("read_only");
  if (kind === "app") {
    data.allowed_features = ["agents.apps"];
    if (data.user) data.user.features = { "agents.apps": true };
    data.migration_registry = data.migration_registry.map((entry) => ({
      ...entry,
      feature_id: "agents.apps",
      title: "업무 앱",
      app_path: "/app/agents/apps",
      legacy_path: "/admin#/apps",
    }));
  }
  const calls: string[] = [],
    unexpected: string[] = [];
  let receiptCount = 0;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      unexpected.push(path);
      return route.abort();
    }
    if (path === "/admin/ui-bootstrap") return json(data);
    if (path === "/health" || path === "/ready") return json({ status: "ok" });
    if (path === `/admin/${kind}s`)
      return json(
        kind === "app"
          ? workAppReadFixture([], Object.fromEntries(url.searchParams))
          : workflowReadFixture([], Object.fromEntries(url.searchParams)),
      );
    if (path === `/me/${kind}-runs`)
      return json({ runs: [{ id: "receipt-one", status: "planned", created_at: "2026-11-13T00:00:00Z" }] });
    if (path === `/v1/${kind}-runs/receipt-one/receipt`) {
      calls.push(path);
      receiptCount++;
      if (failOnce && receiptCount === 1)
        return json({ error: { message: "Synthetic temporary failure" } }, 500);
      return json({
        run_id: "receipt-one",
        app_title: "월간 업무 보고",
        workflow_name: "월간 업무 보고",
        status: "pending_approval",
        output_summary: "2 components planned",
        input_hash: "safe-hash",
        steps_total: 68,
        steps_ok: 67,
        latency_ms: 1250,
        cost_krw: 42,
        created_at: "2026-11-13T00:00:00Z",
        steps: Array.from({ length: 68 }, (_, i) => ({
          step_index: i,
          name: `결과 단계 ${i + 1}`,
          type: i === 67 ? "approval" : "transform",
          status: i === 67 ? "pending_approval" : "ok",
          output_chars: i * 10,
        })),
      });
    }
    if (/^\/(admin|auth|me|v1|mcp)(\/|$)/.test(path)) {
      unexpected.push(`${request.method()} ${path}`);
      return json({}, 501);
    }
    return route.continue();
  });
  return { calls, unexpected };
}
for (const kind of ["app", "workflow"] as const) {
  test(`${kind}: 직접 주소·새로고침·뒤로와 앞으로·키보드 링크`, async ({ page, context }) => {
    const mock = await gateway(context, kind);
    await page.goto(`agents/${kind}s?tab=runs`);
    const link = page.getByRole("link", { name: "실행 receipt-one 영수증 보기", exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: title(kind), exact: true });
    await expect(dialog).toContainText("월간 업무 보고");
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(link).toBeFocused();
    await page.goForward();
    await expect(dialog).toContainText("월간 업무 보고");
    await page.reload();
    await expect(dialog).toContainText("월간 업무 보고");
    expect(new URL(page.url()).searchParams.get("run")).toBe("receipt-one");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("run")).toBe(false);
    expect(mock.unexpected).toEqual([]);
  });
  test(`${kind}: 오류 후 명시적 재조회`, async ({ page, context }) => {
    const mock = await gateway(context, kind, true);
    await page.goto(`agents/${kind}s?tab=runs&run=receipt-one`);
    const dialog = page.getByRole("dialog", { name: title(kind), exact: true });
    await expect(dialog).toContainText("영수증을 불러오지 못했습니다.");
    expect(mock.calls).toHaveLength(1);
    await dialog.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(dialog).toContainText("월간 업무 보고");
    expect(mock.calls).toHaveLength(2);
    expect(mock.unexpected).toEqual([]);
  });
  test(`${kind}: 정의와 실행 동시 선택을 거부한다`, async ({ page, context }) => {
    const mock = await gateway(context, kind);
    await page.goto(`agents/${kind}s?tab=runs&run=receipt-one&${kind}=definition`);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toContainText("영수증 주소를 확인하세요.");
    expect(mock.calls).toEqual([]);
    expect(mock.unexpected).toEqual([]);
  });
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      test(`${kind}: 영수증 시각·접근성 ${theme}-${width}`, async ({ page, context }) => {
        const mock = await gateway(context, kind);
        await page.clock.setFixedTime(new Date("2026-11-13T01:00:00Z"));
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
        await page.goto(`agents/${kind}s?tab=runs&run=receipt-one`);
        const dialog = page.getByRole("dialog", { name: title(kind), exact: true });
        await expect(dialog).toContainText("월간 업무 보고");
        if (kind === "workflow") {
          const table = dialog.getByRole("table", { name: "워크플로 실행 단계별 결과" });
          await expect(table.getByRole("row")).toHaveCount(26);
          await dialog.getByRole("button", { name: "다음", exact: true }).click();
          await expect(table.getByRole("cell", { name: "결과 단계 26", exact: true })).toBeVisible();
          await dialog.getByRole("button", { name: "다음", exact: true }).click();
          await expect(table.getByRole("row")).toHaveCount(19);
          await expect(table.getByRole("cell", { name: "승인 대기", exact: true })).toBeAttached();
          await dialog.getByRole("button", { name: "대화상자 닫기", exact: true }).focus();
        }
        const scroll = dialog.getByRole("region", {
          name: kind === "app" ? "업무 앱 영수증 내용" : "워크플로 영수증 내용",
          exact: true,
        });
        await scroll.evaluate((node) => {
          node.scrollTop = 0;
        });
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
        await expect(page).toHaveScreenshot(`receipt-${kind}-${theme}-${width}.png`);
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        expect(mock.unexpected).toEqual([]);
      });
    }
}
