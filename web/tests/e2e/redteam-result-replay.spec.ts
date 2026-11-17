import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import {
  replayReviewFixture,
  replayOutcomeFixture,
} from "../../src/features/security/redteam/reviewed-replay-fixture";

async function fixture(page: Page, { status = 200, recording = true, history = false } = {}) {
  await page.clock.setFixedTime(new Date("2026-11-17T00:00:00Z"));
  const base = await installPromptLibrary(page);
  if (history) base.bootstrap.backend_version = "v0.86.145";
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  let review = replayReviewFixture({ expires_at: "2026-11-17T00:05:00Z" });
  const originalRun = {
    ...replayOutcomeFixture(review).runs[0],
    id: "public-source-run",
    source_result_id: "",
    review_id: "",
    mode: "dry-run",
  };
  let newRun: typeof originalRun | undefined;
  const writes: string[] = [];
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
      if (path === "/admin/redteam/runs") {
        const query = new URL(request.url()).searchParams;
        const runs = [...(newRun ? [newRun] : []), originalRun].filter(
          (run) => !query.get("source_result_id") || run.source_result_id === query.get("source_result_id"),
        );
        return route.fulfill({
          json:
            query.get("view") === "page"
              ? {
                  runs,
                  total: runs.length,
                  limit: Number(query.get("limit")),
                  offset: Number(query.get("offset")),
                  generated_at: "2026-11-17T00:00:00Z",
                }
              : { runs },
        });
      }
      if (path === "/admin/redteam/runs/public-source-run/results")
        return route.fulfill({ json: { run: originalRun, results: [review.source_result], prompts: {} } });
      if (path === "/admin/redteam/runs/public-run/results")
        return route.fulfill({
          json: {
            run: newRun,
            results: [{ ...review.source_result, id: "public-new-result", run_id: "public-run" }],
            prompts: {},
          },
        });
      if (path === "/admin/redteam/results/public-source-result/evidence")
        return route.fulfill({
          json: {
            evidence: {
              id: "original-evidence",
              result_id: "public-source-result",
              masked_prompt: "보존할 원본 마스킹 요청",
              masked_response: "보존할 원본 마스킹 응답",
              headers_summary: { model: "public-model", provider: "public-provider" },
              tool_calls: [],
            },
          },
        });
      return route.fulfill({ json: {} });
    }
    writes.push(path);
    if (path.endsWith("/rerun-review")) {
      const body = request.postDataJSON();
      expect(body).not.toHaveProperty("proxy_key");
      expect(body.limits.max_calls).toBe(1);
      review = replayReviewFixture({
        reason: body.reason,
        limits: body.limits,
        retain_raw_evidence: body.retain_raw_evidence,
        expires_at: "2026-11-17T00:05:00Z",
      });
      const target = review.targets[0];
      if (!target) throw Error("missing target");
      target.models = [body.model];
      review.requested_output_tokens = body.limits.max_output_tokens;
      return route.fulfill({ json: review });
    }
    expect(path).toBe("/admin/redteam/results/public-source-result/rerun-reviewed");
    expect(request.postDataJSON()).toEqual({
      review_token: review.review_token,
      proxy_key: "public-fixture-key",
    });
    if (status !== 200 && history) newRun = { ...originalRun, ...replayOutcomeFixture(review).runs[0] };
    if (status !== 200)
      return route.fulfill({
        status,
        headers: { "x-request-id": "public-replay-request" },
        json: {
          error: {
            message: "synthetic private upstream payload",
            type: "server_error",
            code: "synthetic_failure",
          },
        },
      });
    const result = replayOutcomeFixture(review);
    if (!recording) {
      result.complete = false;
      result.status = "stopped";
      result.stopped = "recording_failed";
      result.recording = { confirmed: false, stage: "case_result", results: 0 };
      result.summary.results = 0;
      const run = result.runs[0];
      if (run) {
        run.status = "stopped";
        run.total_cases = 0;
      }
    }
    newRun = result.runs[0];
    return route.fulfill({ json: result });
  });
  return { base, writes };
}
async function openReplay(page: Page) {
  await page.goto("redteam?tab=runs");
  await page.getByLabel("레드팀 실행 키", { exact: true }).fill("public-fixture-key");
  await page.getByRole("button", { name: "public-source-run 결과 보기" }).click();
  await page.getByRole("button", { name: "public-case 증적 보기" }).click();
  await expect(page.getByText("보존할 원본 마스킹 요청")).toBeVisible();
  await page.getByRole("button", { name: "조건 검토 후 한 건 재실행" }).click();
  await page.getByLabel("재실행 사유", { exact: false }).fill("원본과 비교할 공개 검사");
}
async function reviewReplay(page: Page) {
  await page.getByRole("button", { name: "재실행 조건 검토", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "한 건 재실행 최종 확인" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("원본 보존과 명시 원문 선택을 검토하고 새 이력으로 이동한다", async ({ page }) => {
  const api = await fixture(page);
  await openReplay(page);
  await expect(page.getByRole("checkbox", { name: "새 증적에 입력·응답 원문 보관" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "새 증적에 입력·응답 원문 보관" }).check();
  const panel = await reviewReplay(page);
  expect(api.writes).toHaveLength(1);
  await expect(panel.getByText("원문 증적을 보관합니다.")).toBeVisible();
  await panel.getByLabel("원본 결과 ID 확인", { exact: false }).fill("public-source-result");
  await panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" }).click();
  await expect(panel.getByText("재실행과 새 결과 저장을 확인했습니다.")).toBeVisible();
  await panel.getByRole("button", { name: "새 실행 결과 보기" }).click();
  await expect(page.getByRole("dialog", { name: "레드팀 결과" })).toBeVisible();
  await expect(page.getByRole("button", { name: "public-case 증적 보기" })).toBeVisible();
  expect(api.writes).toEqual([
    "/admin/redteam/results/public-source-result/rerun-review",
    "/admin/redteam/results/public-source-result/rerun-reviewed",
  ]);
  const storage = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href]),
  );
  expect(storage).not.toContain("public-fixture-key");
  api.base.check();
});

for (const status of [401, 409, 500])
  test(`${status} 미확정 결과는 다시 보내지 않는다`, async ({ page }) => {
    const api = await fixture(page, { status });
    await openReplay(page);
    const panel = await reviewReplay(page);
    await panel.getByLabel("원본 결과 ID 확인", { exact: false }).fill("public-source-result");
    await panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" }).click();
    await expect(panel.getByText(/재실행 결과를 확정할 수 없습니다/)).toBeVisible();
    await expect(panel.getByText("요청 ID: public-replay-request")).toBeVisible();
    await expect(panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" })).toBeDisabled();
    expect(api.writes).toHaveLength(2);
    api.base.check();
  });

test("저장 미확정 결과를 완료로 표시하지 않고 새 이력을 제공한다", async ({ page }) => {
  const api = await fixture(page, { recording: false });
  await openReplay(page);
  const panel = await reviewReplay(page);
  await panel.getByLabel("원본 결과 ID 확인", { exact: false }).fill("public-source-result");
  await panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" }).click();
  await expect(panel.getByText("일부 실행 또는 저장을 확인하지 못했습니다.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "새 실행 결과 보기" })).toBeVisible();
  expect(api.writes).toHaveLength(2);
  api.base.check();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}: 검토·키보드·접근성·포커스 복귀`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await openReplay(page);
      const form = page.getByRole("dialog", { name: "한 건 재실행 조건 검토" });
      await expect(form.getByRole("button", { name: "재실행 조건 검토", exact: true })).toBeInViewport();
      const panel = await reviewReplay(page);
      if (width === 390)
        await expect(panel).toHaveScreenshot(`redteam-replay-${theme}-${width}-overview.png`);
      const field = panel.getByLabel("원본 결과 ID 확인", { exact: false });
      await field.fill("public-source-result");
      const execute = panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" });
      await execute.focus();
      await expect(execute).toBeFocused();
      await expect(execute).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: () => Promise<AxeResults> } }).axe;
          return (await axe.run()).violations;
        }),
      ).toEqual([]);
      await expect(panel).toHaveScreenshot(`redteam-replay-${theme}-${width}.png`);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(page.getByRole("button", { name: "조건 검토 후 한 건 재실행" })).toBeFocused();
      expect(api.writes).toHaveLength(1);
      api.base.check();
    });

test("응답 미확정 후 원본 관련 이력에서 저장된 재실행을 찾는다", async ({ page }) => {
  const api = await fixture(page, { status: 500, history: true });
  await openReplay(page);
  const panel = await reviewReplay(page);
  await panel.getByLabel("원본 결과 ID 확인", { exact: false }).fill("public-source-result");
  await panel.getByRole("button", { name: "검토한 한 건만 실제 재실행" }).click();
  await expect(panel.getByText(/재실행 결과를 확정할 수 없습니다/)).toBeVisible();
  await panel.getByRole("button", { name: "원본 관련 재실행 이력" }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/runs_source_result_id=public-source-result/);
  await expect(page.getByText("조건에 맞는 실행 1건")).toBeVisible();
  await page.getByRole("button", { name: "public-run 결과 보기" }).click();
  await expect(page.getByRole("dialog", { name: "레드팀 결과" })).toBeVisible();
  expect(api.writes).toHaveLength(2);
  api.base.check();
});
