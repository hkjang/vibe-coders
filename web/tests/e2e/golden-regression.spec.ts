import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import { goldenPrompts, goldenResults, goldenWorkflows } from "../fixtures/golden-regression";

async function install(page: Page, allowed = true) {
  const user = {
    id: "public-regression-reader",
    name: "공개 조회 사용자",
    email: "public@example.invalid",
    role: "readonly_admin",
    roles: ["readonly_admin"],
    team_id: "",
    scopes: allowed ? ["admin:read"] : [],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.66",
    ui_version: "regression-public-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/prompts/regression",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: false,
      authenticated: true,
      mode: "open",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
      credential_prefixes: ["corp_"],
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: allowed ? ["prompts.regression"] : [],
    migration_registry: [
      {
        feature_id: "prompts.regression",
        title: "회귀 검증 세트",
        app_path: "/app/prompts/regression",
        legacy_path: "/admin#/prompt-lab",
        status: "preview_read_only",
        risk_level: "low",
        required_permission: "admin:read",
        read_only: true,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: false,
        minimum_api_version: "v0.86.66",
        available: allowed,
        ...(allowed ? {} : { availability_reason: "missing_permission" }),
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = {
    prompts: structuredClone(goldenPrompts),
    results: structuredClone(goldenResults),
    workflows: structuredClone(goldenWorkflows),
    promptStatus: 200,
    workflowStatus: 200,
    malformed: false,
  };
  const calls: { path: string; method: string; query: string }[] = [],
    unexpected: string[] = [],
    pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    calls.push({ path: url.pathname, method: request.method(), query: url.search });
    if (request.method() === "GET" && url.pathname === "/admin/golden-prompts") {
      if (state.promptStatus !== 200)
        return json(
          { error: { message: "public fixture failure", code: "public-error" } },
          state.promptStatus,
        );
      if (state.malformed) return json({ golden_prompts: [], results: [{ id: "public-incomplete" }] });
      const id = url.searchParams.get("prompt_id"),
        limit = Number(url.searchParams.get("limit") ?? "50");
      return json({
        golden_prompts: state.prompts,
        results: state.results.filter((row) => !id || row.prompt_id === id).slice(0, limit),
      });
    }
    if (request.method() === "GET" && url.pathname === "/admin/golden-workflows") {
      if (state.workflowStatus !== 200)
        return json(
          { error: { message: "public fixture failure", code: "public-error" } },
          state.workflowStatus,
        );
      return json({ workflows: state.workflows });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return json({ error: { message: "unexpected public fixture request" } }, 500);
  });
  return {
    state,
    calls,
    check: () => {
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    },
  };
}

async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    // Measure the settled dialog, not its transient opening opacity.
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const result = await (window as unknown as { axe: typeof axe }).axe.run(document);
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      count: violation.nodes.length,
    }));
  });
}

test("기준 프롬프트 상세·직접 접근·새로고침·키보드 복귀", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("prompts/regression");
  const link = page.getByRole("link", { name: "한글 답변 확인", exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "기준 프롬프트 상세" });
  await expect(dialog.getByText("안녕하세요라고 답하세요.")).toBeVisible();
  await expect(dialog.getByText("public-model-a", { exact: true })).toBeVisible();
  await expect(dialog.getByText("public-model-b", { exact: true })).toHaveCount(0);
  expect(
    fixture.calls.some((call) => new URLSearchParams(call.query).get("prompt_id") === "public-prompt-a"),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await link.click();
  await page.reload();
  await expect(dialog.getByText("안녕하세요라고 답하세요.")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page).not.toHaveURL(/selection=/u);
  fixture.check();
});

test("최근 결과 필터·검색·0점 통과와 원문 HTML 비실행", async ({ page }) => {
  const fixture = await install(page);
  const first = fixture.state.results[0];
  if (!first) throw new Error("public result missing");
  first.response = '<img src="x" onerror="window.regressionUnsafe=true">공개 응답';
  await page.goto("prompts/regression?tab=results&outcome=passed&limit=100");
  await expect(page.getByRole("link", { name: "빈 기대 내용 확인" })).toBeVisible();
  await expect(page.getByRole("link", { name: "한글 답변 확인" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("검사 결과", { exact: true })).toHaveValue("passed");
  await page.getByLabel("검사 결과", { exact: true }).selectOption("all");
  await page.getByLabel("프롬프트 이름·모델 검색").fill("public-model-a");
  await expect(page.getByRole("link", { name: "빈 기대 내용 확인" })).toHaveCount(0);
  expect(page.url()).not.toContain("public-model-a");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("public-model-a");
  await page.getByRole("link", { name: "한글 답변 확인" }).click();
  const dialog = page.getByRole("dialog", { name: "실행 결과 상세" });
  await expect(dialog.getByText(first.response, { exact: true })).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, "regressionUnsafe"))).toBe(false);
  fixture.check();
});

test("조회 실패·불완전 응답은 0건 성공으로 표시하지 않고 독립 조회와 복구를 제공", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.promptStatus = 500;
  await page.goto("prompts/regression");
  await expect(page.getByText("데이터를 갱신하지 못했습니다.")).toBeVisible();
  await expect(page.getByText(/아직 등록된 항목이나 저장된 실행 결과/)).toHaveCount(0);
  await page.getByRole("tab", { name: "검증 워크플로", exact: true }).click();
  await expect(page.getByRole("link", { name: "모델 교체 검증" })).toBeVisible();
  fixture.state.promptStatus = 200;
  fixture.state.malformed = true;
  await page.getByRole("tab", { name: "기준 프롬프트", exact: true }).click();
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByText("데이터를 갱신하지 못했습니다.")).toBeVisible();
  fixture.state.malformed = false;
  await page.getByRole("button", { name: "다시 조회", exact: true }).click();
  await expect(page.getByRole("link", { name: "한글 답변 확인" })).toBeVisible();
  fixture.check();
});

test("상세 조회 권한 오류는 이전 내용과 표를 즉시 숨김", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("prompts/regression?tab=results&selection=public-result-a");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("공개 검사 응답")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  fixture.state.promptStatus = 403;
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText("공개 검사 응답")).toHaveCount(0);
  fixture.state.promptStatus = 200;
  await page.getByRole("button", { name: "권한 확인 후 다시 조회" }).click();
  await expect(page.getByRole("link", { name: "한글 답변 확인" })).toBeVisible();
  fixture.check();
});

test("권한 없는 직접 주소 접근은 API를 호출하지 않음", async ({ page }) => {
  const fixture = await install(page, false);
  await page.goto("prompts/regression?selection=public-prompt-a");
  await expect(page.getByRole("heading", { name: "접근 권한이 없습니다." })).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  fixture.check();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`회귀 검증 모바일·키보드·접근성 ${colorScheme} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const fixture = await install(page);
      await page.goto("prompts/regression?tab=workflows");
      const link = page.getByRole("link", { name: "모델 교체 검증", exact: true });
      await expect(link).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await link.click();
      const dialog = page.getByRole("dialog", { name: "검증 워크플로 상세" });
      await expect(dialog.getByText("첫 질문", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: info.outputPath("regression-workflow.png") });
      await dialog.getByRole("button", { name: "닫기", exact: true }).focus();
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(link).toBeFocused();
      await page.getByRole("link", { name: "확인이 필요한 세트", exact: true }).click();
      await expect(page.getByText("단계 정보를 확인할 수 없습니다.")).toBeVisible();
      fixture.check();
    });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`회귀 검증 시각 기준 ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.clock.setFixedTime(new Date("2030-01-04T00:00:00Z"));
    const fixture = await install(page);
    await page.goto("prompts/regression?tab=results");
    await expect(page.getByRole("link", { name: "한글 답변 확인" })).toBeVisible();
    await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeEnabled();
    await expect(page).toHaveScreenshot(`regression-results-${colorScheme}.png`, {
      fullPage: true,
      maxDiffPixels: 120,
    });
    fixture.check();
  });
}
