import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import {
  executionReviewFixture,
  executionOutcomeFixture,
} from "../../src/features/security/redteam/reviewed-execution-fixture";

async function fixture(page: Page, pending = false, version = "v0.86.148") {
  await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = version;
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const writes: string[] = [],
    reads: URLSearchParams[] = [];
  let review = executionReviewFixture(),
    finish = () => {},
    available = false;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() === "GET") {
      if (path.endsWith("/campaigns"))
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
      if (path.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
      if (path.endsWith("/runs") && url.searchParams.get("view") === "page") {
        reads.push(url.searchParams);
        const row = {
          id: "public-tracked-run",
          campaign_id: "public-campaign",
          target_id: "public-target",
          review_id: "public-review",
          status: pending ? "running" : "passed",
          mode: "active-controlled",
          started_at: "2026-11-17T00:00:00Z",
          ended_at: "",
          created_at: "2026-11-17T00:00:00Z",
          total_cases: 0,
          failed_cases: 0,
          risk_score: 0,
          cost_krw: 0,
        };
        return route.fulfill({
          json: {
            runs: available ? [row] : [],
            total: available ? 1 : 0,
            limit: 25,
            offset: 0,
            generated_at: "2026-11-17T00:00:00Z",
          },
        });
      }
      return route.fulfill({ json: {} });
    }
    writes.push(path);
    if (path.endsWith("/run-review")) {
      const body = request.postDataJSON();
      review = executionReviewFixture({
        reason: body.reason,
        limits: body.limits,
        expires_at: "2026-11-17T00:05:00Z",
      });
      return route.fulfill({ json: review });
    }
    expect(path).toBe("/admin/redteam/campaigns/public-campaign/run-reviewed");
    expect(request.postDataJSON()).toEqual({
      review_token: review.review_token,
      proxy_key: "public-synthetic-key",
    });
    if (pending) {
      await completion;
      return route.fulfill({ json: executionOutcomeFixture(review) });
    }
    return route.fulfill({ status: 503, json: { error: { code: "public-response-unavailable" } } });
  });
  return {
    ...base,
    writes,
    reads,
    finish,
    reveal: () => {
      available = true;
    },
  };
}
async function execute(page: Page) {
  await page.goto(
    "redteam?tab=campaigns&runs_status=failed&runs_kind=replay&runs_page=6&runs_source_result_id=old-result&runs_sort=id:asc",
  );
  await page.getByLabel(/실행 키/).fill("public-synthetic-key");
  await page.getByRole("button", { name: "공개 실행 실제 실행", exact: true }).click();
  await page.getByLabel("실행 사유", { exact: false }).fill("공개 실행 점검");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "실행 조건 최종 확인" });
  await expect(panel.getByRole("button", { name: "이 검토의 실행 이력" })).toHaveCount(0);
  await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
  await panel.getByRole("button", { name: "검토한 조건으로 한 번 실행" }).click();
  return panel;
}
for (const pending of [true, false])
  test(`${pending ? "실행 중" : "응답 오류"}: 같은 검토 이력만 조회하고 다시 실행하지 않는다`, async ({
    page,
  }) => {
    const api = await fixture(page, pending);
    const panel = await execute(page);
    if (!pending) await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/)).toBeVisible();
    const history = panel.getByRole("button", { name: "이 검토의 실행 이력" });
    await history.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("검토별 실행 이력", { exact: true })).toBeVisible();
    await expect(page.getByText("조건에 맞는 실행 0건")).toBeVisible();
    expect(new URL(page.url()).searchParams.toString()).toBe(
      "tab=runs&runs_kind=campaign&runs_campaign_id=public-campaign&runs_review_id=public-review",
    );
    expect(Object.fromEntries(api.reads.at(-1) ?? [])).toEqual({
      view: "page",
      limit: "25",
      offset: "0",
      kind: "campaign",
      campaign_id: "public-campaign",
      review_id: "public-review",
    });
    await expect(page.getByText(/호출되지 않았다고 판단하거나 다시 실행하지 마세요/)).toBeVisible();
    api.reveal();
    await page.getByRole("button", { name: "이력 새로고침", exact: true }).click();
    await expect(page.getByText("조건에 맞는 실행 1건")).toBeVisible();
    api.finish();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("조건에 맞는 실행 1건")).toBeVisible();
    expect(api.writes).toHaveLength(2);
    api.check();
  });

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`응답 오류 후 이력 이동 버튼 ${theme} ${width}`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await execute(page);
      await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/)).toBeVisible();
      await expect(panel.getByRole("alert")).toBeInViewport({ ratio: 1 });
      const history = panel.getByRole("button", { name: "이 검토의 실행 이력" });
      await expect(history).toBeInViewport();
      const bounds = await history.boundingBox();
      expect(bounds).not.toBeNull();
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      const accessibility = await page.evaluate(async () =>
        (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
      );
      expect(accessibility.violations).toEqual([]);
      await expect(panel).toHaveScreenshot(`redteam-tracking-action-${theme}-${width}.png`);
      await history.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("검토별 실행 이력", { exact: true })).toBeVisible();
      expect(api.writes).toHaveLength(2);
      api.check();
    });
test("이전 서버는 지원하지 않는 검토별 이력 버튼을 숨긴다", async ({ page }) => {
  const api = await fixture(page, false, "v0.86.147");
  const panel = await execute(page);
  await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "이 검토의 실행 이력" })).toHaveCount(0);
  expect(api.writes).toHaveLength(2);
  api.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`검토별 이력 안내 ${theme} ${width}`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.goto(
        "redteam?tab=runs&runs_kind=campaign&runs_campaign_id=public-campaign&runs_review_id=public-review",
      );
      await expect(page.getByText("조건에 맞는 실행 0건")).toBeVisible();
      const accessibility = await page.evaluate(async () =>
        (window as typeof window & { axe: { run: () => Promise<AxeResults> } }).axe.run(),
      );
      expect(accessibility.violations).toEqual([]);
      await expect(page).toHaveScreenshot(`redteam-tracking-${theme}-${width}.png`, { fullPage: true });
      expect(api.writes).toEqual([]);
      api.check();
    });
