import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import {
  executionReviewFixture,
  executionOutcomeFixture,
} from "../../src/features/security/redteam/reviewed-execution-fixture";
async function fixture(page: Page, status = 200) {
  await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.140";
  base.bootstrap.allowed_features = ["security.redteam"];
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw Error("missing feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const writes: string[] = [];
  let review = executionReviewFixture();
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path.endsWith("campaigns"))
        return route.fulfill({
          json: {
            campaigns: [
              {
                id: "public-campaign",
                name: "공개 실행",
                scope: "all",
                status: "approved",
                execution_mode: "active-controlled",
              },
            ],
          },
        });
      if (path.endsWith("kill-switch")) return route.fulfill({ json: { enabled: false } });
      return route.fulfill({ json: {} });
    }
    writes.push(path);
    if (path.endsWith("run-review")) {
      const body = request.postDataJSON();
      expect(body).not.toHaveProperty("proxy_key");
      review = executionReviewFixture({
        kind: body.kind,
        reason: body.reason,
        expires_at: "2026-11-17T00:05:00Z",
        limits: body.limits,
      });
      if (body.kind === "simulation") {
        review.planned_live_calls = 0;
        review.requested_output_tokens = 0;
        const target = review.targets[0];
        if (!target) throw Error("missing review target");
        target.models = [];
        target.live_calls = 0;
      }
      return route.fulfill({ json: review });
    }
    expect(path).toBe("/admin/redteam/campaigns/public-campaign/run-reviewed");
    expect(request.postDataJSON()).toEqual({
      review_token: review.review_token,
      ...(review.kind === "live" ? { proxy_key: "public-synthetic-key" } : {}),
    });
    return route.fulfill({
      status,
      json: status === 200 ? executionOutcomeFixture(review) : { error: { code: "public-review-conflict" } },
    });
  });
  return { ...base, writes };
}
async function open(page: Page, simulation = false) {
  await page.goto("redteam?tab=campaigns");
  await page.getByLabel(/실행 키/).fill("public-synthetic-key");
  await page.getByRole("button", { name: "공개 실행 실제 실행", exact: true }).click();
  if (simulation) await page.getByLabel("이번 실행 방식").selectOption("simulation");
  await page.getByLabel("실행 사유", { exact: false }).fill("공개 실행 점검");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "실행 조건 최종 확인" });
  await expect(panel).toBeVisible();
  return panel;
}
for (const simulation of [false, true])
  test(`${simulation ? "시뮬레이션" : "실제 호출"}: 검토 후 이름을 확인하고 한 번 실행한다`, async ({
    page,
  }) => {
    const api = await fixture(page);
    const panel = await open(page, simulation);
    expect(api.writes).toEqual(["/admin/redteam/campaigns/public-campaign/run-review"]);
    const execute = panel.getByRole("button", { name: "검토한 조건으로 한 번 실행" });
    await expect(execute).toBeDisabled();
    await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
    await execute.click();
    await expect(page.getByRole("dialog", { name: "캠페인 실행 결과" })).toBeVisible();
    expect(api.writes).toHaveLength(2);
    api.check();
  });
for (const status of [409, 500])
  test(`${status}: 불확실한 결과를 자동 재실행하지 않는다`, async ({ page }) => {
    const api = await fixture(page, status);
    const panel = await open(page);
    await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
    await panel.getByRole("button", { name: "검토한 조건으로 한 번 실행" }).click();
    await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
    expect(api.writes).toHaveLength(2);
    api.check();
  });
test("취소는 실행하지 않고 현재 행에 초점을 돌려준다", async ({ page }) => {
  const api = await fixture(page);
  const panel = await open(page);
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("button", { name: "공개 실행 실제 실행", exact: true })).toBeFocused();
  expect(api.writes).toHaveLength(1);
  api.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 검토 화면·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await open(page);
      await expect(panel).toHaveScreenshot(`redteam-reviewed-execution-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scan = await page.evaluate(
        async () =>
          await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
            document,
          ),
      );
      expect(scan.violations.map((v) => ({ id: v.id, impact: v.impact }))).toEqual([]);
      await panel.getByRole("region", { name: "실행 조건 검토 내용" }).focus();
      await page.keyboard.press("End");
      await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
      await page.keyboard.press("Tab");
      expect(api.writes).toHaveLength(1);
      api.check();
    });
