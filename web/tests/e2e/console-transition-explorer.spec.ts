import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installSettingsWorkspace } from "../fixtures/settings-workspace-browser";

async function install(page: Page, role = "admin") {
  const state = await installSettingsWorkspace(page, role);
  const template = state.settings[0];
  if (!template) throw new Error("Settings fixture missing");
  state.settings = (
    [
      ["system.settings", "preview", "false"],
      ["gateway.providers", "preview_read_only", "true"],
      ["routing.rules", "legacy", "false"],
    ] as const
  ).flatMap(([id, status, readonly]) =>
    (
      [
        ["status", status, "string"],
        ["roles", "admin,readonly_admin", "csv"],
        ["rollout", "30", "int"],
        ["readonly", readonly, "bool"],
      ] as const
    ).map(([field, value, type]) => ({
      ...template,
      key: `ui.app.feature.${id}.${field}`,
      category: "ui.app.features",
      description: "기능별 콘솔 전환 설정",
      value,
      type,
      can_write: role === "admin",
    })),
  );
  await page.route("**/admin/ui-telemetry/summary*", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        days: 7,
        from: "2026-11-11T00:00:00Z",
        to: "2026-11-18T00:00:00Z",
        retention_days: 30,
        visit_limit: 100000,
        features: [],
      },
    }),
  );
  return state;
}
const featureTable = (page: Page) => page.getByRole("table", { name: "기능별 콘솔 전환 상태", exact: true });

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`전환 기능 필터·주소 복원·편집 복귀 ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1050 });
      await page.addInitScript(
        (theme) =>
          localStorage.setItem(
            "vibe.app.preferences.v1",
            JSON.stringify({ state: { theme, density: "default" }, version: 0 }),
          ),
        theme,
      );
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const state = await install(page);
      await page.goto("system/settings?tab=console&telemetry_days=7");
      const table = featureTable(page);
      await expect(table.getByRole("row")).toHaveCount(4);
      const reads = state.reads;
      await page.getByRole("textbox", { name: "전환 기능 검색", exact: true }).fill("시스템");
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await page.getByLabel("전환 상태 필터", { exact: true }).selectOption("preview");
      await page.getByLabel("쓰기 차단 설정", { exact: true }).selectOption("false");
      await expect(table.getByRole("row")).toHaveCount(2);
      expect(state.reads).toBe(reads);
      await expect(page).toHaveURL(/console_q=/);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "전환 기능 검색", exact: true })).toHaveValue("시스템");
      await expect(table.getByRole("row")).toHaveCount(2);
      const edit = table.getByRole("button", { name: "시스템 설정 전환 설정 편집", exact: true });
      await edit.focus();
      await edit.press("Enter");
      const editor = page.getByRole("dialog", { name: "시스템 설정 전환 설정", exact: true });
      await expect(editor).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();
      await expect(edit).toBeFocused();
      await edit.press("Enter");
      await expect(editor).toBeVisible();
      await page.goBack();
      await expect(editor).toBeHidden();
      await expect(table.getByRole("row")).toHaveCount(2);
      const panel = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "기능별 전환 상태", exact: true }) });
      await page.getByRole("textbox", { name: "전환 기능 검색", exact: true }).focus();
      await page.getByRole("region", { name: "기능별 전환 상태 표", exact: true }).evaluate((element) => {
        element.scrollLeft = 0;
      });
      await panel.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(panel).toHaveScreenshot(`console-filter-${theme}-${width}.png`, {
        animations: "disabled",
      });

      const results = await page.evaluate(async () =>
        (window as unknown as { axe: { run(): Promise<AxeResults> } }).axe.run(),
      );
      expect(results.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.getByRole("button", { name: "전환 조회 조건 초기화" }).click();
      await expect(table.getByRole("row")).toHaveCount(4);
      expect(new URL(page.url()).searchParams.get("telemetry_days")).toBe("7");
      expect(state.writes).toEqual([]);
      expect(state.unexpected).toEqual([]);
    });
  }

test("잘못된 조건은 빈 결과로 오인하지 않고 명시 초기화로 복구한다", async ({ page }) => {
  const state = await install(page);
  await page.goto("system/settings?tab=console&console_status=invalid");
  await expect(page.getByText(/전환 기능의 조회 조건을 확인할 수 없습니다/)).toBeVisible();
  await expect(featureTable(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(/전환 기능의 조회 조건을 확인할 수 없습니다/)).toBeVisible();
  await page.getByRole("button", { name: "전환 조회 조건 초기화" }).click();
  await expect(featureTable(page).getByRole("row")).toHaveCount(4);
  expect(state.writes).toEqual([]);
});

test("조회 실패를 기능 없음과 구분하고 다시 조회한다", async ({ page }) => {
  const state = await install(page);
  state.failOnce = true;
  await page.goto("system/settings?tab=console");
  await expect(page.getByText("조회 실패로 기능 수를 확인할 수 없습니다.")).toBeVisible();
  await expect(page.getByText("전환 설정을 제공하는 기능이 없습니다.")).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(featureTable(page).getByRole("row")).toHaveCount(4);
  expect(state.writes).toEqual([]);
});

test("조회 계정도 기능을 찾되 편집창 저장은 기존 권한으로 차단한다", async ({ page }) => {
  const state = await install(page, "readonly_admin");
  await page.goto("system/settings?tab=console&console_q=system&console_status=preview");
  await featureTable(page).getByRole("button", { name: "시스템 설정 전환 설정 편집", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "시스템 설정 전환 설정", exact: true });
  await expect(editor.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
});
