import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { refreshRuntime } from "../fixtures/agent-code-editor";
import { evidenceReadFixture } from "../../src/features/security/redteam/evidence-read-fixture";
import {
  replayOutcomeFixture,
  replayReviewFixture,
} from "../../src/features/security/redteam/reviewed-replay-fixture";

async function fixture(page: Page, rawAllowed = true) {
  const base = await installPromptLibrary(page, true);
  base.bootstrap.backend_version = "v0.86.146";
  base.bootstrap.capabilities = { raw_prompt_view: rawAllowed };
  base.bootstrap.allowed_features = ["security.redteam"];
  Object.assign(base.bootstrap.migration_registry[0] ?? {}, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const run = { ...replayOutcomeFixture().runs[0], id: "public-run" };
  const result = { ...replayReviewFixture().source_result, id: "public-result", run_id: "public-run" };
  const reads: string[] = [];
  let auditFailure = false;
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(request.method()).toBe("GET");
    if (url.pathname.endsWith("/evidence")) {
      expect(url.searchParams.get("view")).toBe("app");
      const reveal = url.searchParams.get("reveal") === "raw";
      reads.push(reveal ? "raw" : "masked");
      if (reveal && auditFailure)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "redteam_evidence_audit_unavailable",
              message: "조회 감사 기록을 저장하지 못해 원문을 열지 않았습니다.",
              type: "server_error",
            },
          },
          headers: { "x-request-id": "public-evidence-error" },
        });
      return route.fulfill({ json: { ...evidenceReadFixture(reveal), raw_allowed: rawAllowed } });
    }
    if (url.pathname.endsWith("/results")) {
      expect(url.searchParams.get("view")).toBe("app");
      return route.fulfill({
        json: {
          run,
          results: [result],
          prompts: { "public-result": "마스킹된 요청" },
          count: 1,
          masked: true,
        },
      });
    }
    if (url.pathname === "/admin/redteam/runs")
      return route.fulfill({
        json: {
          runs: [run],
          total: 1,
          limit: Number(url.searchParams.get("limit")),
          offset: Number(url.searchParams.get("offset")),
          generated_at: "2026-11-17T00:00:00Z",
        },
      });
    return route.fulfill({ json: url.pathname.endsWith("kill-switch") ? { enabled: false } : {} });
  });
  return {
    ...base,
    reads,
    failAudit: () => {
      auditFailure = true;
    },
  };
}
async function open(page: Page) {
  await page.goto("redteam?tab=runs&run=public-run");
  await page.getByRole("button", { name: "public-case 증적 보기", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "증적 상세", exact: true });
  await expect(panel.getByLabel("요청 프롬프트 (실제 전송 형태 · 마스킹)")).toHaveText("마스킹된 요청");
  return panel;
}
test("원문은 명시적으로 열고 닫으며 권한 변경 후 화면에서 제거한다", async ({ page }) => {
  const api = await fixture(page);
  const panel = await open(page);
  expect(api.reads).toEqual(["masked"]);
  await panel.getByRole("button", { name: "원문 보기", exact: true }).click();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveText("원본 응답 내용");
  await refreshRuntime(page);
  expect(api.reads.filter((mode) => mode === "raw")).toHaveLength(1);
  await panel.getByRole("button", { name: "원문 닫기", exact: true }).click();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveCount(0);
  await panel.getByRole("button", { name: "원문 보기", exact: true }).click();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toBeVisible();
  expect(api.reads.filter((mode) => mode === "raw")).toHaveLength(2);
  api.bootstrap.capabilities = { raw_prompt_view: false };
  await refreshRuntime(page);
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("원본 응답 내용", { exact: true })).toHaveCount(0);
  api.check();
});
test("조회 전용 사용자는 마스킹 증적만 확인한다", async ({ page }) => {
  const api = await fixture(page, false);
  const panel = await open(page);
  await expect(panel.getByText("원문 증적 조회 권한이 없어 마스킹본만 표시합니다.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "원문 보기", exact: true })).toHaveCount(0);
  expect(api.reads).toEqual(["masked"]);
  api.check();
});
test("감사 기록 실패는 요청 ID와 안내를 표시하고 원문을 열지 않는다", async ({ page }) => {
  const api = await fixture(page);
  const panel = await open(page);
  api.failAudit();
  await panel.getByRole("button", { name: "원문 보기", exact: true }).click();
  await expect(
    panel.getByText("조회 감사 기록을 저장하지 못해 원문을 열지 않았습니다. 다시 시도하세요."),
  ).toBeVisible();
  await expect(panel.getByText(/public-evidence-error/)).toBeVisible();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveCount(0);
  expect(api.reads).toEqual(["masked", "raw"]);
  api.check();
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}: 증적 패널·원문 버튼·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await open(page);
      const button = panel.getByRole("button", { name: "원문 보기", exact: true });
      await button.focus();
      await expect(button).toBeFocused();
      await expect(panel).toHaveScreenshot(`redteam-evidence-${theme}-${width}.png`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const audit = await panel.evaluate(async (element) =>
        (window as typeof window & { axe: { run: (element: Element) => Promise<AxeResults> } }).axe.run(
          element,
        ),
      );
      expect(audit.violations).toEqual([]);
      await button.press("Enter");
      await expect(panel.getByLabel("실제 요청 프롬프트 (원문)")).toHaveText("원본 요청 내용");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole("button", { name: "public-case 증적 보기", exact: true })).toBeFocused();
      api.check();
    });
