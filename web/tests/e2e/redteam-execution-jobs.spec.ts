import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { executionJobFixture, executionJobId } from "../../src/features/security/redteam/job-fixture";
import { executionReviewFixture } from "../../src/features/security/redteam/reviewed-execution-fixture";

async function fixture(page: Page, lostReply = false) {
  await page.clock.setFixedTime(new Date("2026-11-20T08:00:00Z"));
  const base = await installPromptLibrary(page);
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  let admitted = false,
    finished = false,
    denied = false,
    postCount = 0;
  const reads: string[] = [];
  let review = executionReviewFixture({ job_id: executionJobId });
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() === "GET") {
      if (path.endsWith("/run-reviewed")) {
        reads.push(url.search);
        expect(url.searchParams.get("job_id")).toBe(executionJobId);
        if (denied) return route.fulfill({ status: 403, json: { error: { code: "denied" } } });
        if (!admitted) return route.fulfill({ status: 404, json: { error: { code: "not_yet_admitted" } } });
        return route.fulfill({ json: executionJobFixture(finished) });
      }
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
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/run-review")) {
      const body = request.postDataJSON();
      review = executionReviewFixture({
        job_id: executionJobId,
        reason: body.reason,
        limits: body.limits,
        expires_at: "2026-11-20T08:05:00Z",
      });
      return route.fulfill({ json: review });
    }
    expect(path).toBe("/admin/redteam/campaigns/public-campaign/run-reviewed");
    expect(url.search).toBe("?job=1");
    expect(request.postDataJSON()).toEqual({
      review_token: review.review_token,
      proxy_key: "public-synthetic-key",
    });
    postCount++;
    admitted = true;
    if (lostReply) return route.abort("connectionclosed");
    return route.fulfill({ status: 202, json: executionJobFixture() });
  });
  return {
    ...base,
    reads,
    count: () => postCount,
    finish: () => {
      finished = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
async function submit(page: Page) {
  await page.goto("redteam?tab=campaigns");
  await page.getByLabel(/실행 키/u).fill("public-synthetic-key");
  await page.getByRole("button", { name: "공개 실행 실제 실행", exact: true }).click();
  await page.getByLabel("실행 사유", { exact: false }).fill("공개 실행 점검");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "실행 조건 최종 확인" });
  await dialog.getByLabel("캠페인 이름 확인", { exact: false }).fill("공개 실행");
  await dialog.getByRole("button", { name: "검토한 조건으로 한 번 실행" }).click();
  return dialog;
}
test("접수 후 새로고침은 GET으로 이어지고 완료 결과를 연다", async ({ page }) => {
  const api = await fixture(page);
  const dialog = await submit(page);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "레드팀 검사 진행 중" })).toBeVisible();
  const url = new URL(page.url());
  expect(url.searchParams.get("execution_job")).toBe(executionJobId);
  expect(url.searchParams.get("job_campaign")).toBe("public-campaign");
  expect(url.href).not.toContain("public-synthetic-key");
  expect(url.href).not.toContain("review_token");
  await page.reload();
  await expect(page.getByRole("heading", { name: "레드팀 검사 진행 중" })).toBeVisible();
  api.finish();
  await page.getByRole("button", { name: "작업 상태 새로고침" }).click();
  await expect(page.getByRole("heading", { name: "레드팀 검사 완료" })).toBeVisible();
  await page.getByRole("button", { name: "저장된 실행 결과" }).click();
  await expect(page.getByRole("dialog", { name: "캠페인 실행 결과" })).toBeVisible();
  expect(api.count()).toBe(1);
  expect(api.reads.length).toBeGreaterThan(1);
  api.check();
});
test("접수 응답 유실 후 닫기·새로고침으로 복구하며 다시 실행하지 않는다", async ({ page }) => {
  const api = await fixture(page, true);
  const dialog = await submit(page);
  await expect(dialog.getByText(/실행 결과를 확정할 수 없습니다/u)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "검토한 조건으로 한 번 실행" })).toBeDisabled();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "레드팀 검사 진행 중" })).toBeVisible();
  expect(api.count()).toBe(1);
  api.check();
});
test("권한 회수 후 진행 상태를 지우고 작업 주소를 닫는다", async ({ page }) => {
  const api = await fixture(page);
  await submit(page);
  await expect(page.getByRole("heading", { name: "레드팀 검사 진행 중" })).toBeVisible();
  api.deny();
  await page.getByRole("button", { name: "작업 상태 새로고침" }).click();
  await expect(page.getByText("레드팀 작업 조회 권한을 확인하세요.")).toBeVisible();
  await expect(page.getByText("0 / 1건")).toBeHidden();
  await page.getByRole("button", { name: "작업 주소 지우기" }).click();
  expect(new URL(page.url()).searchParams.has("execution_job")).toBe(false);
  expect(api.count()).toBe(1);
  api.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 작업 진행·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await submit(page);
      const heading = page.getByRole("heading", { name: "레드팀 검사 진행 중" });
      await expect(heading).toBeVisible();
      const panel = heading.locator("xpath=ancestor::section[1]");
      await expect(panel).toHaveScreenshot(`redteam-job-${theme}-${width}.png`, { animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scan = await page.evaluate(
        async () =>
          await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
            document,
          ),
      );
      expect(scan.violations.map(({ id, impact }) => ({ id, impact }))).toEqual([]);
      await page.getByRole("button", { name: "작업 상태 새로고침" }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "작업 표시 닫기" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(heading).toBeHidden();
      expect(api.count()).toBe(1);
      api.check();
    });
