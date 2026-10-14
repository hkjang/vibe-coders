import { expect, test, type Page } from "@playwright/test";
import type axe from "axe-core";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

async function install(page: Page, holdCall?: Promise<void>) {
  const user = {
    id: "public-call-admin",
    email: "policy@example.invalid",
    name: "정책 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["observability:read", "mcp:admin"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.61",
    ui_version: "call-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/mcp",
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
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: ["mcp.overview"],
    migration_registry: [
      {
        feature_id: "mcp.overview",
        title: "MCP 운영",
        app_path: "/app/mcp",
        legacy_path: "/admin#/mcp",
        status: "preview",
        risk_level: "medium",
        required_permission: "observability:read",
        read_only: false,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = { decision: "allow", conflict: false, testStatus: 200, malformed: false, calls: 0 };
  const writes: unknown[] = [],
    unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/mcp/overview") return json({ upstream_count: 1 });
    if (url.pathname === "/admin/mcp/routes") return json({ routes: [], errors: {} });
    if (url.pathname === "/admin/mcp/topology") return json({ nodes: [], edges: [] });
    if (url.pathname === "/admin/mcp/route/explain" && request.method() === "POST") {
      state.calls++;
      if (state.malformed) return json({ route: { found: true }, final: { decision: "allow" } });
      return json({
        input: request.postDataJSON() as unknown,
        route: {
          found: true,
          upstream_id: state.conflict && state.calls > 1 ? "other" : "public-id",
          upstream_name: "공개 서버",
          target_method: "tools/call",
          target_name: "read",
          lookup: "public__read",
        },
        policy: {
          server_policy: "allow",
          tool_risk_level: "low",
          tool_risk_action: "allow",
          tool_risk_configured: false,
          tool_risk_note: "",
        },
        final: { decision: state.decision, reason: "route found" },
      });
    }
    if (url.pathname === "/admin/mcp/test" && request.method() === "POST") {
      writes.push(request.postDataJSON() as unknown);
      await holdCall;
      if (state.testStatus !== 200)
        return route.fulfill({
          status: state.testStatus,
          headers: { "X-Request-ID": "public-call-error" },
          json: { error: { message: "private failure", code: "unavailable", type: "server_error" } },
        });
      return json({
        ok: true,
        upstream_id: "public-id",
        upstream_name: "공개 서버",
        method: "tools/call",
        latency_ms: 4,
        response_preview: "공개 응답",
      });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500, json: {} });
  });
  return { state, writes, unexpected, bootstrap, user };
}
async function inspect(page: Page) {
  await page.goto("/app/mcp");
  await page.getByLabel("노출 이름", { exact: true }).fill("public__read");
  await page.getByLabel("JSON 인수", { exact: true }).fill('{"text":"공개 요청"}');
  await page.getByRole("button", { name: "적용 경로 확인", exact: true }).click();
  await expect(page.getByText("확인한 메서드", { exact: true })).toBeVisible();
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "실제 MCP 호출 검토", exact: true });
async function open(page: Page) {
  await inspect(page);
  await page.getByRole("button", { name: "테스트 호출 검토", exact: true }).click();
  return dialog(page);
}

test("다른 탭의 호출이 진행 중이면 대기 실행 없이 중복 전송을 차단한다", async ({ page, context }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = await install(page, pending);
  const secondPage = await context.newPage();
  const second = await install(secondPage);
  try {
    const firstReview = await open(page);
    const secondReview = await open(secondPage);
    await firstReview.getByLabel(/확인 문구/).fill("실제 호출");
    await secondReview.getByLabel(/확인 문구/).fill("실제 호출");
    await firstReview.getByRole("button", { name: "검토한 호출 실행", exact: true }).click();
    await expect.poll(() => first.writes.length).toBe(1);
    await secondReview.getByRole("button", { name: "검토한 호출 실행", exact: true }).click();
    await expect(
      secondReview.getByText("다른 탭에서 MCP 호출이 진행 중입니다. 완료 후 다시 검토하세요.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(second.writes).toEqual([]);
    expect(second.state.calls).toBe(1);
    release();
    await expect(page.getByText("호출 성공", { exact: true })).toBeVisible();
    expect(second.writes).toEqual([]);
    await secondReview.getByRole("button", { name: "취소", exact: true }).click();
    const freshReview = await open(secondPage);
    await freshReview.getByLabel(/확인 문구/).fill("실제 호출");
    await freshReview.getByRole("button", { name: "검토한 호출 실행", exact: true }).click();
    await expect(secondPage.getByText("호출 성공", { exact: true })).toBeVisible();
    expect(second.writes).toHaveLength(1);
  } finally {
    release();
    await secondPage.close();
  }
});

test("검토 후 정확한 인수·대상으로 한 번 호출하고 결과를 초기화한다", async ({ page }) => {
  const fixture = await install(page);
  const review = await open(page);
  const submit = review.getByRole("button", { name: "검토한 호출 실행", exact: true });
  await expect(submit).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  await review.getByLabel(/확인 문구/).fill("실제 호출");
  await submit.dblclick();
  await expect(page.getByText("호출 성공", { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([
    {
      method: "tools/call",
      name: "public__read",
      uri: "",
      upstream_id: "public-id",
      arguments: { text: "공개 요청" },
    },
  ]);
  expect(fixture.state.calls).toBe(2);
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeDisabled();
  await page.getByLabel("노출 이름", { exact: true }).fill("public__other");
  await expect(page.getByText("호출 성공", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("노출 이름", { exact: true })).toHaveValue("");
  expect(fixture.unexpected).toEqual([]);
});
test("탭 간 잠금이 없으면 경로만 확인하고 실제 호출은 차단한다", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  const fixture = await install(page);
  await inspect(page);
  await expect(page.getByText(/탭 간 호출 잠금을 사용할 수 없어 실제 호출을 중지했습니다/)).toBeVisible();
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.state.calls).toBe(1);
});
test("읽기 전용은 경로 확인만 가능하고 관리자 범위 없는 조회자는 설명도 보내지 않는다", async ({ page }) => {
  const fixture = await install(page);
  const feature = fixture.bootstrap.migration_registry[0];
  if (!feature) throw new Error("MCP fixture feature missing");
  feature.read_only = true;
  await inspect(page);
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeDisabled();
  fixture.user.scopes = ["observability:read"];
  fixture.bootstrap.permissions = fixture.user.scopes;
  await page.reload();
  await expect(page.getByRole("button", { name: "적용 경로 확인", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});
test("차단·불완전 설명은 실행 검토를 열지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.decision = "approval_required";
  await inspect(page);
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeDisabled();
  fixture.state.malformed = true;
  await page.getByRole("button", { name: "적용 경로 확인", exact: true }).click();
  await expect(page.getByText("서버 응답 형식을 확인할 수 없습니다.", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});
test("경로 변경과 전송 후 오류를 구분하고 즉시 재호출하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  fixture.state.conflict = true;
  const review = await open(page);
  await review.getByLabel(/확인 문구/).fill("실제 호출");
  await review.getByRole("button", { name: "검토한 호출 실행", exact: true }).click();
  await expect(
    review.getByText("경로 또는 정책 변경으로 실행하지 않았습니다. 창을 닫고 다시 검토하세요.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  await review.getByRole("button", { name: "취소", exact: true }).click();
  fixture.state.conflict = false;
  fixture.state.testStatus = 503;
  await page.getByRole("button", { name: "적용 경로 확인", exact: true }).click();
  await page.getByRole("button", { name: "테스트 호출 검토", exact: true }).click();
  await review.getByLabel(/확인 문구/).fill("실제 호출");
  await review.getByRole("button", { name: "검토한 호출 실행", exact: true }).click();
  await expect(
    review.getByText("이미 호출을 전송했습니다. 외부 상태를 확인하기 전에는 재실행하지 마세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "검토한 호출 실행", exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  expect(
    await page.evaluate(async () =>
      (await navigator.locks.query()).held?.filter((lock) => lock.name === "vibe:app:mcp-test-call"),
    ),
  ).toEqual([]);
});
test("잘못된 JSON은 해당 입력으로 초점을 옮기고 API를 호출하지 않는다", async ({ page }) => {
  const fixture = await install(page);
  await page.goto("/app/mcp");
  await page.getByLabel("노출 이름", { exact: true }).fill("public__read");
  const args = page.getByLabel("JSON 인수", { exact: true });
  await args.fill("[]");
  await page.getByRole("button", { name: "적용 경로 확인", exact: true }).click();
  await expect(args).toBeFocused();
  await expect(args).toHaveAttribute("aria-invalid", "true");
  expect(fixture.state.calls).toBe(0);
  expect(new URL(page.url()).search).toBe("");
});
test("390px 어두운 호출 검토창의 키보드·초점·접근성과 내부 스크롤", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const fixture = await install(page);
  const review = await open(page);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  expect(
    await page.evaluate(async () =>
      (
        await (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        })
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const footer = review.getByRole("button", { name: "검토한 호출 실행", exact: true });
  await expect(footer).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("mcp-call-review-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "테스트 호출 검토", exact: true })).toBeFocused();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
