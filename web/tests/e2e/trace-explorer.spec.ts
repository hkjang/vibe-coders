import { expect, test, type Page } from "@playwright/test";

interface AxeRuntime {
  run: (root: Document) => Promise<{
    violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }>;
  }>;
}

interface TraceProjectionCall {
  headers: Record<string, string>;
  url: URL;
}

interface TraceGatewayHarness {
  calls: TraceProjectionCall[];
  filterViolations: string[];
  unexpectedAdminCalls: string[];
}

const providerRef = `prv_${"t".repeat(43)}`;
const traceNextCursor = `djE6dHJhY2UtbmV4dA.${"n".repeat(43)}`;
const tracePreviousCursor = `djE6dHJhY2UtcHJldmlvdXM.${"p".repeat(43)}`;
const exactTraceId = "Trace-Mixed_Case:001";
const rangeFrom = "2026-09-03T23:00:00Z";
const rangeTo = "2026-09-04T02:00:00+00:00";

const bootstrap = {
  backend_version: "v0.83.0",
  ui_version: "e2e-v0.83.0",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/observability/traces",
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
  user: {
    id: "trace-e2e-admin",
    email: "trace-e2e@example.invalid",
    name: "추적 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read"],
    features: { "observability.traces": true },
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["observability.traces"],
  migration_registry: [
    {
      feature_id: "observability.traces",
      title: "추적 탐색기",
      app_path: "/app/observability/traces",
      legacy_path: "/admin#/runtime-traces",
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.83.0",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/observability/traces": "/admin#/runtime-traces" },
};

const selectedRequest = {
  request_id: "req-trace-001",
  trace_id: exactTraceId,
  session_id: "session-trace-001",
  api_key_id: "key-trace-001",
  ip: "192.0.2.20",
  method: "POST",
  model: "gpt-trace-test",
  provider_ref: providerRef,
  provider_display: "추적 공급자",
  endpoint: "/v1/chat/completions",
  stream: true,
  status_code: 503,
  latency_ms: 420,
  first_chunk_ms: 75,
  prompt_tokens: 150,
  completion_tokens: 60,
  total_tokens: 210,
  cached_tokens: 20,
  reasoning_tokens: 8,
  estimated_cost: 234.5,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-09-04T01:00:00Z",
};

const relatedRequest = {
  ...selectedRequest,
  request_id: "req-trace-002",
  latency_ms: 1_250,
  total_tokens: 0,
  estimated_cost: 0,
  finish_reason: "upstream_error",
  created_at: "2026-09-04T01:00:00.250Z",
};

const nextPageRequest = {
  ...selectedRequest,
  request_id: "req-trace-page-2",
  session_id: "session-trace-002",
  created_at: "2026-09-04T00:59:00Z",
};

const firstPage = {
  requests: [selectedRequest, relatedRequest],
  limit: 25,
  next_cursor: traceNextCursor,
  generated_at: "2026-09-04T01:00:05Z",
};

const secondPage = {
  requests: [nextPageRequest],
  limit: 25,
  previous_cursor: tracePreviousCursor,
  generated_at: "2026-09-04T01:00:06Z",
};

async function axeViolations(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeRuntime }).axe;
    const result = await axe.run(document);
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  });
}

function validateTraceFilters(
  url: URL,
  expectedFilters: Readonly<Record<string, string>>,
  violations: string[],
): void {
  for (const [key, expected] of Object.entries(expectedFilters)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) violations.push(`${key}: expected one value, received ${values.length}`);
    const actual = values[0] ?? null;
    if (actual !== expected) violations.push(`${key}: expected ${expected}, received ${String(actual)}`);
  }
  const allowedKeys = new Set([...Object.keys(expectedFilters), "cursor"]);
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowedKeys.has(key)) violations.push(`unexpected query key: ${key}`);
    if (url.searchParams.getAll(key).length !== 1) {
      violations.push(`${key}: duplicate query values are not allowed`);
    }
  }
}

async function mockTraceGateway(
  page: Page,
  expectedFilters: Readonly<Record<string, string>>,
): Promise<TraceGatewayHarness> {
  const calls: TraceProjectionCall[] = [];
  const filterViolations: string[] = [];
  const unexpectedAdminCalls: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/admin/ui-bootstrap") {
      if (request.method() !== "GET") {
        unexpectedAdminCalls.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 405 });
      }
      return json(bootstrap);
    }
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/requests") {
      calls.push({ headers: request.headers(), url });
      if (request.method() !== "GET") {
        unexpectedAdminCalls.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 405 });
      }
      validateTraceFilters(url, expectedFilters, filterViolations);
      const cursor = url.searchParams.get("cursor");
      const limit = Number(expectedFilters.limit);
      if (cursor === traceNextCursor) return json({ ...secondPage, limit });
      if (cursor === null || cursor === tracePreviousCursor) return json({ ...firstPage, limit });
      filterViolations.push(`unexpected cursor: ${cursor}`);
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "invalid_requests_cursor" } }),
      });
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      unexpectedAdminCalls.push(`${request.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    }

    if (request.resourceType() === "document" && url.pathname.startsWith("/app/")) {
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  return { calls, filterViolations, unexpectedAdminCalls };
}

test("추적 탐색기 딥링크와 새로고침에서 안전한 필터·선택·페이지 이동 계약을 유지한다", async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const expectedFilters = {
    trace_id: exactTraceId,
    status: "error",
    model: "gpt-trace-test",
    limit: "25",
    from: rangeFrom,
    to: rangeTo,
    tz: "UTC",
  };
  const harness = await mockTraceGateway(page, expectedFilters);
  const deepLink = new URLSearchParams({
    ...expectedFilters,
    selected_request: "req-trace-001",
    prompt: "raw-private",
    api_key: "vc_sk_fake-private",
    token: "fake-private",
  });

  await page.goto(`observability/traces?${deepLink.toString()}`);

  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeVisible();
  await expect(page.getByLabel("추적 ID", { exact: true })).toHaveValue(exactTraceId);
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("error");
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("gpt-trace-test");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(rangeFrom);
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(rangeTo);
  await expect(page.getByRole("heading", { name: "요청 req-trace-001", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "요청 req-trace-001 상세 보기" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("link", { name: "기존 화면 보기" })).toHaveAttribute(
    "href",
    "/admin#/runtime-traces",
  );

  const expectedGeneratedTime = await page.evaluate(
    (generatedAt) =>
      new Intl.DateTimeFormat("ko-KR", {
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(generatedAt)),
    firstPage.generated_at,
  );
  await expect(page.getByTestId("traces-generated-at")).toHaveText(expectedGeneratedTime);

  await expect.poll(() => harness.calls.length).toBeGreaterThan(0);
  const initialCall = harness.calls[0];
  expect(initialCall?.headers["x-vibe-ui"]).toBe("app");
  expect(initialCall?.headers["x-vibe-ui-version"]).toBeTruthy();
  expect(initialCall?.headers["x-vibe-route"]).toBe("observability.traces");
  expect(initialCall?.url.searchParams.get("trace_id")).toBe(exactTraceId);
  expect(initialCall?.url.searchParams.get("status")).toBe("error");
  expect(initialCall?.url.searchParams.get("model")).toBe("gpt-trace-test");
  expect(initialCall?.url.searchParams.get("limit")).toBe("25");
  expect(initialCall?.url.searchParams.get("from")).toBe(rangeFrom);
  expect(initialCall?.url.searchParams.get("to")).toBe(rangeTo);
  expect(initialCall?.url.searchParams.get("tz")).toBe("UTC");
  expect(initialCall?.url.searchParams.has("selected_request")).toBe(false);
  expect(initialCall?.url.searchParams.has("prompt")).toBe(false);
  expect(initialCall?.url.searchParams.has("api_key")).toBe(false);
  expect(initialCall?.url.searchParams.has("token")).toBe(false);

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return [url.searchParams.has("prompt"), url.searchParams.has("api_key"), url.searchParams.has("token")];
    })
    .toEqual([false, false, false]);
  expect(await axeViolations(page)).toEqual([]);

  await page.reload();
  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeVisible();
  await expect(page.getByLabel("추적 ID", { exact: true })).toHaveValue(exactTraceId);
  await expect(page.getByRole("heading", { name: "요청 req-trace-001", exact: true })).toBeVisible();
  await expect.poll(() => harness.calls.length).toBeGreaterThan(1);
  expect(harness.calls.at(-1)?.url.searchParams.get("trace_id")).toBe(exactTraceId);
  expect(harness.calls.at(-1)?.headers["x-vibe-route"]).toBe("observability.traces");
  await expect(page.getByTestId("traces-generated-at")).toHaveText(expectedGeneratedTime);

  await page.getByRole("button", { name: "요청 상세 닫기" }).click();
  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeFocused();
  const firstDetailTrigger = page.getByRole("button", { name: "요청 req-trace-001 상세 보기" });
  await firstDetailTrigger.click();
  const firstDetail = page.getByRole("region", { name: "요청 req-trace-001" });
  await expect(firstDetail).toBeFocused();
  await expect(firstDetailTrigger).toHaveAttribute("aria-controls", "trace-request-detail");
  await expect(firstDetailTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("요청 req-trace-001 상세가 열렸습니다.", { exact: true })).toBeAttached();
  await page.getByRole("button", { name: "요청 상세 닫기" }).click();
  await expect(firstDetailTrigger).toBeFocused();

  await page.getByRole("button", { name: "다음" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("cursor")).toBe(traceNextCursor);
  await expect(page).not.toHaveURL(/selected_request=/u);
  await expect(page.getByRole("button", { name: "요청 req-trace-page-2 상세 보기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "요청 req-trace-001", exact: true })).toBeHidden();
  await expect
    .poll(
      () => harness.calls.filter((call) => call.url.searchParams.get("cursor") === traceNextCursor).length,
    )
    .toBe(1);
  const nextCall = harness.calls.find((call) => call.url.searchParams.get("cursor") === traceNextCursor);
  for (const [key, value] of Object.entries(expectedFilters)) {
    expect(nextCall?.url.searchParams.get(key)).toBe(value);
  }
  expect(await axeViolations(page)).toEqual([]);

  const nextPageCallCount = harness.calls.filter(
    (call) => call.url.searchParams.get("cursor") === traceNextCursor,
  ).length;
  await page.reload();
  await expect(page.getByRole("button", { name: "요청 req-trace-page-2 상세 보기" })).toBeVisible();
  await expect
    .poll(
      () => harness.calls.filter((call) => call.url.searchParams.get("cursor") === traceNextCursor).length,
    )
    .toBeGreaterThan(nextPageCallCount);

  await page.getByRole("button", { name: "이전" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("cursor")).toBe(tracePreviousCursor);
  await expect(page).not.toHaveURL(/selected_request=/u);
  await expect(page.getByRole("button", { name: "요청 req-trace-001 상세 보기" })).toBeVisible();
  await expect
    .poll(() => harness.calls.some((call) => call.url.searchParams.get("cursor") === tracePreviousCursor))
    .toBe(true);
  const previousCall = harness.calls.find(
    (call) => call.url.searchParams.get("cursor") === tracePreviousCursor,
  );
  for (const [key, value] of Object.entries(expectedFilters)) {
    expect(previousCall?.url.searchParams.get(key)).toBe(value);
  }
  expect(await axeViolations(page)).toEqual([]);
  expect(harness.filterViolations).toEqual([]);
  expect(harness.unexpectedAdminCalls).toEqual([]);
});

test("정확한 HTTP 상태·사용자 지정 건수·RFC3339 기간을 폼과 요청 탐색기 링크에 보존한다", async ({
  page,
}) => {
  const expectedFilters = {
    trace_id: exactTraceId,
    status: "503",
    model: "gpt-trace-test",
    limit: "75",
    from: rangeFrom,
    to: rangeTo,
    tz: "UTC",
  };
  const harness = await mockTraceGateway(page, expectedFilters);
  await page.goto(`observability/traces?${new URLSearchParams(expectedFilters).toString()}`);

  await expect(page.getByRole("heading", { name: "추적 탐색기", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("503");
  await expect(page.getByRole("combobox", { name: "표시 건수", exact: true })).toHaveValue("75");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(rangeFrom);
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(rangeTo);

  const explorerHref = await page
    .getByRole("link", { name: "요청 탐색기", exact: true })
    .getAttribute("href");
  const explorerURL = new URL(explorerHref ?? "", page.url());
  expect(explorerURL.pathname).toBe("/app/observability/requests");
  for (const [key, value] of Object.entries(expectedFilters)) {
    expect(explorerURL.searchParams.get(key)).toBe(value);
  }
  expect(explorerURL.searchParams.has("cursor")).toBe(false);
  expect(explorerURL.searchParams.has("selected_request")).toBe(false);

  await page.getByRole("button", { name: "흐름 조회" }).click();
  for (const [key, value] of Object.entries(expectedFilters)) {
    await expect(page).toHaveURL(
      new RegExp(`${key}=${encodeURIComponent(value).replaceAll("%20", "\\+")}`, "u"),
    );
  }
  await page.reload();
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("503");
  await expect(page.getByRole("combobox", { name: "표시 건수", exact: true })).toHaveValue("75");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(rangeFrom);
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(rangeTo);

  await page.getByRole("link", { name: "요청 탐색기", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/observability\/requests\?/u);
  await expect(page.getByRole("heading", { name: "요청 탐색기", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("503");
  await page.locator("summary", { hasText: "고급 필터" }).click();
  await expect(page.getByRole("combobox", { name: "표시 건수", exact: true })).toHaveValue("75");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(rangeFrom);
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(rangeTo);
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("503");
  await page.locator("summary", { hasText: "고급 필터" }).click();
  await expect(page.getByRole("combobox", { name: "표시 건수", exact: true })).toHaveValue("75");
  await expect(page.getByLabel("시작 시각", { exact: true })).toHaveValue(rangeFrom);
  await expect(page.getByLabel("종료 시각", { exact: true })).toHaveValue(rangeTo);
  await expect
    .poll(() => harness.calls.some((call) => call.headers["x-vibe-route"] === "observability.requests"))
    .toBe(true);
  expect(harness.filterViolations).toEqual([]);
  expect(harness.unexpectedAdminCalls).toEqual([]);
});
