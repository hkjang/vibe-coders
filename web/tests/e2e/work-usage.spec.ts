import { expect, test, type Page } from "@playwright/test";

import {
  fixtureReads,
  fixtureSessionDetail,
  type FixtureQuery,
} from "../../src/features/insights/usage/usage-fixtures";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic responses only: this proves the screen (URL state, drill-down, export
// request), not the server's classification or aggregation. Every value is made up.
const feature = {
  feature_id: "insights.usage",
  title: "업무 활용 분석",
  app_path: "/app/insights/usage",
  legacy_path: "/admin#/dwdashboard",
  status: "preview",
  risk_level: "medium",
  required_permission: "admin:read",
  read_only: false,
  enabled_roles: [] as string[],
  rollout_percent: 100,
  fallback_enabled: false,
  minimum_api_version: "v0.86.186",
  available: true,
};

interface Gateway {
  /** Query of every analytics read, by its name under /admin/work-intel. */
  reads: Record<string, URLSearchParams[]>;
  exports: URLSearchParams[];
  last: (name: string) => URLSearchParams | undefined;
  /** Whether any read of `name` carried `key=value` (panels and filter lists share endpoints). */
  sent: (name: string, key: string, value: string) => boolean;
}

const csv = "﻿category,sessions\r\n소프트웨어 개발,640\r\n";

async function install(page: Page): Promise<Gateway> {
  const gateway: Gateway = {
    reads: {},
    exports: [],
    last: (name) => gateway.reads[name]?.at(-1),
    sent: (name, key, value) => (gateway.reads[name] ?? []).some((query) => query.get(key) === value),
  };
  const user = {
    id: "usage-analyst",
    email: "analyst@example.invalid",
    name: "분석 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap = {
    backend_version: "v0.86.186",
    ui_version: "work-usage-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/insights/usage",
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
    allowed_features: ["insights.usage"],
    migration_registry: [feature],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  } as UiBootstrapResponse;

  await page.route("**/*", async (intercepted) => {
    const request = intercepted.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return intercepted.continue();
    const path = url.pathname;
    if (path === "/admin/ui-bootstrap") return intercepted.fulfill({ json: bootstrap });
    if (path === "/auth/me") return intercepted.fulfill({ json: user });
    if (path === "/health") return intercepted.fulfill({ json: { status: "ok" } });
    const prefix = "/admin/work-intel/";
    if (path.startsWith(prefix) && request.method() === "GET") {
      const name = path.slice(prefix.length);
      if (name === "export.csv") {
        gateway.exports.push(url.searchParams);
        return intercepted.fulfill({
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
          body: csv,
        });
      }
      if (name.startsWith("sessions/")) {
        return intercepted.fulfill({
          json: fixtureSessionDetail(decodeURIComponent(name.slice("sessions/".length))),
        });
      }
      const read = fixtureReads[name];
      if (read) {
        (gateway.reads[name] ??= []).push(url.searchParams);
        return intercepted.fulfill({ json: read(Object.fromEntries(url.searchParams) as FixtureQuery) });
      }
    }
    return intercepted.fulfill({
      status: 404,
      json: { error: { message: "not mocked", type: "invalid_request_error", code: "not_found" } },
    });
  });
  return gateway;
}

const team = "플랫폼팀";
const param = (page: Page, key: string): string | null => new URL(page.url()).searchParams.get(key);

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test("restores the filters from the URL on load, after a reload and after Back", async ({ page }) => {
  const gateway = await install(page);
  await page.goto(`insights/usage?tab=categories&days=7&team=${encodeURIComponent(team)}&metric=cost`);
  await expect(page.getByRole("heading", { name: "업무 활용 분석", level: 1 })).toBeVisible();

  const restored = async (): Promise<void> => {
    await expect(page.getByRole("tab", { name: "업무 유형" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("팀")).toHaveValue(team);
    await expect(page.getByLabel("집계 기준")).toHaveValue("cost");
    await expect(page.getByLabel("현재 조회 범위")).toContainText(`필터 1개 적용 · 팀 ${team}`);
    await expect(page.getByLabel("현재 조회 범위")).toContainText("(7일)");
    await expect(page.getByRole("table", { name: "전체 업무 대분류 목록" })).toBeVisible();
  };
  await restored();
  // The filter bar reads the same endpoint for its option lists, without the team filter.
  const sent = gateway.reads.categories?.find((query) => query.get("team") === team);
  expect(sent?.get("team")).toBe(team);
  expect(sent?.get("metric")).toBe("cost");
  expect(sent?.get("compare")).toBe("prev");
  const from = Date.parse(`${sent?.get("from") ?? ""}T00:00:00Z`);
  const to = Date.parse(`${sent?.get("to") ?? ""}T00:00:00Z`);
  expect((to - from) / 86_400_000).toBe(6);

  await page.reload();
  await restored();

  // A drill-down is a history entry: Back returns to the level above with the filters intact.
  await page.getByRole("button", { name: "소프트웨어 개발 하위 분류 보기" }).click();
  await expect(page.getByRole("table", { name: "소프트웨어 개발 중분류 목록" })).toBeVisible();
  expect(param(page, "parent")).toBe("dev");
  await page.goBack();
  await restored();
  expect(param(page, "parent")).toBeNull();
  await page.goForward();
  await expect(page.getByRole("table", { name: "소프트웨어 개발 중분류 목록" })).toBeVisible();
  await expect(page.getByLabel("팀")).toHaveValue(team);
});

test("drills from 대분류 to a leaf, lands on its sessions and opens one", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("insights/usage?tab=categories");
  await expect(page.getByRole("table", { name: "전체 업무 대분류 목록" })).toBeVisible();

  // First step through a chart mark: the treemap tile.
  await page.getByRole("button", { name: /^소프트웨어 개발 · 640 · 51\.6% · 하위 분류/u }).click();
  await expect(page.getByRole("table", { name: "소프트웨어 개발 중분류 목록" })).toBeVisible();
  expect(param(page, "parent")).toBe("dev");
  expect(gateway.sent("categories", "parent", "dev")).toBe(true);

  await page.getByRole("button", { name: "코드 생성 하위 분류 보기" }).click();
  await expect(page.getByRole("table", { name: "코드 생성 소분류 목록" })).toBeVisible();
  expect(param(page, "parent")).toBe("dev.codegen");
  const crumbs = page.getByRole("navigation", { name: "업무 분류 단계" });
  await expect(crumbs.getByRole("button", { name: "소프트웨어 개발" })).toBeVisible();
  await expect(crumbs.getByText("코드 생성", { exact: true })).toHaveAttribute("aria-current", "page");

  // A leaf has no children: it opens the sessions of that category.
  await page.getByRole("button", { name: "API 구현 세션 보기" }).click();
  await expect(page.getByRole("tab", { name: "세션·요청" })).toHaveAttribute("aria-selected", "true");
  expect(param(page, "category")).toBe("dev.codegen.api");
  expect(param(page, "parent")).toBeNull();
  const sessions = page.getByRole("table", { name: "업무 세션 목록" });
  await expect(sessions).toBeVisible();
  expect(gateway.last("sessions")?.get("category")).toBe("dev.codegen.api");
  expect(gateway.last("sessions")?.get("limit")).toBe("25");
  await expect(page.getByLabel("업무 분류 소분류")).toHaveValue("dev.codegen.api");

  await page.getByRole("button", { name: "세션 sess_0001 상세 열기" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("table", { name: "세션의 업무 구간" })).toBeVisible();
  expect(param(page, "session")).toBe("sess_0001");
  await expect(sheet.getByRole("table", { name: "세션의 요청" }).getByRole("link").first()).toHaveAttribute(
    "href",
    "/app/observability/requests?request_id=req_00001",
  );

  // Back closes the session, then returns to the 소분류 level.
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(sessions).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("table", { name: "코드 생성 소분류 목록" })).toBeVisible();
});

test("switching the metric refetches every panel with metric= and keeps it in the URL", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("insights/usage");
  await expect(page.getByRole("region", { name: "요약 지표" })).toBeVisible();
  expect(gateway.last("overview")?.get("metric")).toBe("sessions");
  await expect(page.getByRole("img", { name: "업무 유형별 업무 세션 수 비중" })).toBeVisible();

  await page.getByLabel("집계 기준").selectOption("tokens");
  await expect(page).toHaveURL(/[?&]metric=tokens(&|$)/u);
  await expect(page.getByRole("img", { name: "업무 유형별 토큰 사용량 비중" })).toBeVisible();
  for (const name of ["overview", "categories", "trend", "matrix"]) {
    await expect.poll(() => gateway.sent(name, "metric", "tokens")).toBe(true);
  }
  await expect(page.getByLabel("현재 조회 범위")).toContainText("집계 기준토큰 사용량");

  await page.reload();
  await expect(page.getByLabel("집계 기준")).toHaveValue("tokens");
});

test("exports the current tab as CSV with the current filters", async ({ page }) => {
  const gateway = await install(page);
  await page.goto(
    `insights/usage?tab=models&days=90&team=${encodeURIComponent(team)}&metric=cost&compare=none`,
  );
  await expect(page.getByRole("table", { name: "업무별 모델 사용 현황" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^work-usage-models-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/u,
  );

  const sent = gateway.exports.at(-1);
  expect(sent?.get("view")).toBe("models");
  expect(sent?.get("team")).toBe(team);
  expect(sent?.get("metric")).toBe("cost");
  expect(sent?.get("compare")).toBe("none");
  // The export covers the same period the screen reads.
  expect(sent?.get("from")).toBe(gateway.last("models")?.get("from"));
  expect(sent?.get("to")).toBe(gateway.last("models")?.get("to"));

  // A drill-down level narrows the category export to that category.
  await page.goto("insights/usage?tab=categories&parent=dev");
  await expect(page.getByRole("table", { name: "소프트웨어 개발 중분류 목록" })).toBeVisible();
  const second = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  await second;
  expect(gateway.exports.at(-1)?.get("view")).toBe("categories");
  expect(gateway.exports.at(-1)?.get("category")).toBe("dev");
});

test("fits a 420px-wide screen on every tab without sideways scrolling", async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 420, height: 900 });
  const landmarks: Record<string, () => Promise<void>> = {
    summary: () => expect(page.getByRole("list", { name: "인사이트 목록" })).toBeVisible(),
    categories: () => expect(page.getByRole("table", { name: "전체 업무 대분류 목록" })).toBeVisible(),
    teams: () => expect(page.getByRole("table", { name: "조직별 업무 활용", exact: true })).toBeVisible(),
    models: () => expect(page.getByRole("table", { name: "업무별 모델 사용 현황" })).toBeVisible(),
    trends: () => expect(page.getByRole("table", { name: "자동화 후보" })).toBeVisible(),
    sessions: () => expect(page.getByRole("table", { name: "업무 세션 목록" })).toBeVisible(),
    productivity: () => expect(page.getByRole("table", { name: "업무별 관측값과 추정 절감" })).toBeVisible(),
  };
  for (const [tab, visible] of Object.entries(landmarks)) {
    await page.goto(`insights/usage?tab=${tab}`);
    await visible();
    await noSidewaysScroll(page);
  }
  // The deepest drill-down level and an open session sheet fit as well.
  await page.goto("insights/usage?tab=categories&parent=dev.codegen");
  await expect(page.getByRole("table", { name: "코드 생성 소분류 목록" })).toBeVisible();
  await noSidewaysScroll(page);
  await page.goto("insights/usage?tab=sessions&session=sess_0002");
  await expect(page.getByRole("dialog").getByRole("table", { name: "세션의 업무 구간" })).toBeVisible();
  await noSidewaysScroll(page);
});
