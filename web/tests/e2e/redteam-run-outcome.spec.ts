import {
  executionReviewFixture,
  executionOutcomeFixture,
} from "../../src/features/security/redteam/reviewed-execution-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

async function fixture(page: Page, stopped = "budget_exceeded", status = 200, recordingFailure = false) {
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.140";
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
  const run = {
    id: "public-run",
    target_id: "공개 테스트 모델",
    campaign_id: "public-campaign",
    status: "stopped",
    total_cases: 1,
    mode: "active-controlled",
  };
  const writes: string[] = [];
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/admin/redteam/campaigns")
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
      if (path === "/admin/redteam/runs") return route.fulfill({ json: { runs: [run] } });
      if (path === "/admin/redteam/runs/public-run/results")
        return route.fulfill({ json: { run, results: [] } });
      return route.fulfill({ json: path.endsWith("kill-switch") ? { enabled: false } : {} });
    }
    writes.push(`${request.method()} ${path}`);
    if (path.endsWith("/run-review")) return route.fulfill({ json: executionReviewFixture() });
    expect(path).toBe("/admin/redteam/campaigns/public-campaign/run-reviewed");
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual({
      review_token: "r".repeat(43),
      proxy_key: "public-synthetic-key",
    });
    return route.fulfill({
      status,
      json:
        status === 200
          ? {
              ...executionOutcomeFixture(),
              status: "stopped",
              stopped,
              complete: false,
              recording: {
                confirmed: !recordingFailure,
                stage: recordingFailure ? "finalize" : "",
                results: 1,
              },
              runs: [{ ...executionOutcomeFixture().runs[0], ...run }],
              summary: { ...executionOutcomeFixture().summary, live_cost_krw: 20 },
            }
          : { error: { code: "synthetic_unauthorized" } },
    });
  });
  return { ...base, writes };
}

async function open(page: Page) {
  await page.goto("redteam?tab=campaigns");
  await page.getByLabel(/실행 키/).fill("public-synthetic-key");
  await page.getByRole("button", { name: "공개 실행 실제 실행", exact: true }).click();
  await page.getByLabel("실행 사유", { exact: false }).fill("공개 실행 점검");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  await page.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
  await page.getByRole("button", { name: "검토한 조건으로 한 번 실행" }).click();
  const panel = page.getByRole("dialog", { name: "캠페인 실행 결과", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

for (const [reason, label] of [
  ["budget_exceeded", "비용 중단 기준에 도달했습니다"],
  ["kill_switch", "긴급 중지가 적용되었습니다"],
  ["call_limit", "실제 호출 횟수 한도에 도달했습니다"],
  ["context_cancelled", "요청 연결 또는 실행 대기가 취소되었습니다"],
] as const)
  test(`${reason}: 한글 중단 안내에서 일부 결과만 열고 재실행하지 않는다`, async ({ page }) => {
    const api = await fixture(page, reason);
    const panel = await open(page);
    await expect(panel.getByText(label, { exact: false })).toBeVisible();
    await expect(panel.getByText("중단", { exact: true })).toBeVisible();
    await expect(panel.getByText("아니오 — 시뮬레이션", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "공개 테스트 모델 · 중단 · 결과 1건 보기" }).click();
    const results = page.getByRole("dialog", { name: "레드팀 결과", exact: true });
    await expect(results.getByText("중단된 실행의 일부 결과입니다.")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("table", { name: "레드팀 캠페인 실행 이력" }).getByText("중단", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toEqual([
      "POST /admin/redteam/campaigns/public-campaign/run-review",
      "POST /admin/redteam/campaigns/public-campaign/run-reviewed",
    ]);
    api.check();
  });

test("실행 요청의 401을 인증 갱신 후 자동으로 재전송하지 않는다", async ({ page }) => {
  const api = await fixture(page, "budget_exceeded", 401);
  await page.goto("redteam?tab=campaigns");
  await page.getByLabel(/실행 키/).fill("public-synthetic-key");
  await page.getByRole("button", { name: "공개 실행 실제 실행", exact: true }).click();
  await page.getByLabel("실행 사유", { exact: false }).fill("공개 실행 점검");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  await page.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
  await page.getByRole("button", { name: "검토한 조건으로 한 번 실행" }).click();
  await expect.poll(() => api.writes.length).toBe(2);
  await expect(page.getByRole("dialog", { name: "캠페인 실행 결과", exact: true })).toHaveCount(0);
  expect(api.writes).toHaveLength(2);
  api.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 중단 결과 시각·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await open(page);
      await expect(panel).toHaveScreenshot(`redteam-run-outcome-${theme}-${width}.png`, {
        animations: "disabled",
      });
      const scroll = panel.getByRole("region", { name: "캠페인 실행 결과 내용" });
      await scroll.focus();
      await scroll.press("End");
      await panel.getByText("실행 식별자와 서버 안내", { exact: true }).click();
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(panel.getByText("공개 테스트 데이터입니다. 실행 기록을 확인하세요.")).toBeVisible();
      expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(
        async () =>
          (
            await (
              window as unknown as {
                axe: { run: (root: Document) => Promise<AxeResults> };
              }
            ).axe.run(document)
          ).violations,
      );
      expect(violations).toEqual([]);
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible();
      await expect(page.getByRole("button", { name: "공개 실행 실제 실행", exact: true })).toBeFocused();
      expect(api.writes).toHaveLength(2);
      api.check();
    });

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 저장 확인 실패·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page, "recording_failed", 200, true);
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await open(page);
      await expect(panel.getByText("결과 저장을 확인하지 못했습니다.", { exact: true })).toBeVisible();
      await expect(panel.getByText("저장 확인 필요", { exact: true })).toBeVisible();
      await expect(panel.getByText("완료", { exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: /재실행|재개/ })).toHaveCount(0);
      await expect(panel).toHaveScreenshot(`redteam-recording-${theme}-${width}.png`, {
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scan = await page.evaluate(
        async () =>
          await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
            document,
          ),
      );
      expect(scan.violations).toEqual([]);
      await panel.getByRole("region", { name: "캠페인 실행 결과 내용" }).focus();
      await page.keyboard.press("End");
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "공개 실행 실제 실행", exact: true })).toBeFocused();
      expect(api.writes).toHaveLength(2);
      api.check();
    });
