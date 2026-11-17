import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { preflightFixture } from "../../src/features/security/redteam/preflight-fixture";

async function fixture(page: Page) {
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.137";
  base.bootstrap.allowed_features = ["security.redteam"];
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw Error("missing fixture feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const state: { status: number; response: unknown } = { status: 200, response: preflightFixture };
  const requests: string[] = [];
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/admin/redteam/campaigns")
        return route.fulfill({
          json: {
            campaigns: [
              {
                id: preflightFixture.campaign_id,
                name: "공개 사전 점검",
                scope: "all",
                execution_mode: "dry-run",
                status: "draft",
                budget_limit_krw: 5,
              },
            ],
          },
        });
      return route.fulfill({ json: path.endsWith("kill-switch") ? { enabled: false } : {} });
    }
    requests.push(`${request.method()} ${path}`);
    expect(request.method()).toBe("POST");
    expect(path).toBe("/admin/redteam/campaigns/public-preflight/dry-run");
    expect(request.headers()["x-vibe-route"]).toBe("security.redteam");
    return route.fulfill({
      status: state.status,
      json: state.status === 200 ? state.response : { error: { code: "synthetic_unavailable" } },
    });
  });
  return { ...base, state, requests };
}

async function open(page: Page) {
  const trigger = page.getByRole("button", { name: "공개 사전 점검 사전 점검", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await trigger.press("Enter");
  const panel = page.getByRole("dialog", { name: "사전 점검 결과", exact: true });
  await expect(panel).toBeVisible();
  return { panel, trigger };
}

test("승인 조건 충족과 예산 초과를 구분하며 실행 요청은 보내지 않는다", async ({ page }) => {
  const api = await fixture(page);
  await page.goto("redteam?tab=campaigns");
  const { panel, trigger } = await open(page);
  await expect(panel.getByText("승인 조건 충족", { exact: true })).toBeVisible();
  await expect(panel.getByText("예산 초과 · 실행 전 조정 필요")).toBeAttached();
  await expect(panel.getByText("실행 가능", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "실행", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.getByRole("tab", { name: "캠페인", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(api.requests).toEqual(["POST /admin/redteam/campaigns/public-preflight/dry-run"]);
  api.check();
});

for (const kind of ["missing", "wrong-campaign", "unavailable"] as const)
  test(`${kind}: 부정확한 결과를 열지 않고 새 점검으로 복구한다`, async ({ page }) => {
    const api = await fixture(page);
    if (kind === "missing") api.state.response = {};
    if (kind === "wrong-campaign") api.state.response = { ...preflightFixture, campaign_id: "wrong" };
    if (kind === "unavailable") api.state.status = 503;
    await page.goto("redteam?tab=campaigns");
    const trigger = page.getByRole("button", { name: "공개 사전 점검 사전 점검", exact: true });
    await trigger.click();
    await expect(
      page.getByText(
        kind === "unavailable"
          ? "서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요."
          : "서버 응답 형식을 확인할 수 없습니다.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "사전 점검 결과", exact: true })).toHaveCount(0);
    await expect(trigger).toBeEnabled();
    expect(api.requests).toHaveLength(1);
    api.state.response = preflightFixture;
    api.state.status = 200;
    await open(page);
    expect(api.requests).toHaveLength(2);
    api.check();
  });

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 사전 점검 시각·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto("redteam?tab=campaigns");
      const { panel, trigger } = await open(page);
      const scroll = panel.getByRole("region", { name: "사전 점검 결과 내용" });
      await expect(panel).toHaveScreenshot(`redteam-preflight-${theme}-${width}-top.png`, {
        animations: "disabled",
      });
      await scroll.focus();
      await scroll.press("End");
      await panel.getByText("점검 식별자와 서버 안내", { exact: true }).click();
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(panel.getByText(preflightFixture.note, { exact: true })).toBeVisible();
      await expect(panel).toHaveScreenshot(`redteam-preflight-${theme}-${width}-bottom.png`, {
        animations: "disabled",
      });
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(api.requests).toHaveLength(1);
      api.check();
    });
