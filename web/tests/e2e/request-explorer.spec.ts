import { expect, test, type Page } from "@playwright/test";

interface AxeRuntime {
  run: (root: Document) => Promise<{
    violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }>;
  }>;
}

interface RequestProjectionCall {
  cursor: string;
  headers: Record<string, string>;
  url: URL;
}

const providerRef = `prv_${"r".repeat(43)}`;
const requestNextCursor = `djE6cmVxdWVzdC1uZXh0.${"n".repeat(43)}`;
const requestPreviousCursor = `djE6cmVxdWVzdC1wcmV2aW91cw.${"p".repeat(43)}`;

const bootstrap = {
  backend_version: "v0.82.1",
  ui_version: "e2e-v0.82.1",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/observability/requests",
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
    id: "request-e2e-admin",
    email: "request-e2e@example.invalid",
    name: "요청 운영자",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read"],
    features: { "observability.requests": true },
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["observability.requests"],
  migration_registry: [
    {
      feature_id: "observability.requests",
      title: "요청 탐색기",
      app_path: "/app/observability/requests",
      legacy_path: "/admin#/requests",
      status: "preview_read_only",
      risk_level: "low",
      required_permission: "admin:read",
      read_only: true,
      enabled_roles: ["admin"],
      rollout_percent: 100,
      fallback_enabled: true,
      minimum_api_version: "v0.82.1",
      available: true,
    },
  ],
  system_status: { status: "healthy" },
  legacy_route_map: { "/app/observability/requests": "/admin#/requests" },
};

const requestOne = {
  request_id: "req-001",
  trace_id: "trace-001",
  session_id: "session-001",
  api_key_id: "key-001",
  ip: "192.0.2.10",
  method: "POST",
  model: "gpt-test",
  provider_ref: providerRef,
  provider_display: "공급자 1",
  endpoint: "/v1/chat/completions",
  stream: true,
  status_code: 200,
  latency_ms: 321,
  first_chunk_ms: 80,
  prompt_tokens: 120,
  completion_tokens: 45,
  total_tokens: 165,
  cached_tokens: 10,
  reasoning_tokens: 5,
  estimated_cost: 123.45,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-09-03T01:00:00Z",
};

const requestTwo = {
  ...requestOne,
  request_id: "req-002",
  trace_id: "trace-002",
  session_id: "session-002",
  status_code: 503,
  latency_ms: 1_205,
  total_tokens: 0,
  estimated_cost: 0,
  finish_reason: "upstream_error",
  created_at: "2026-09-03T00:59:00Z",
};

const firstPage = {
  requests: [requestOne],
  limit: 25,
  next_cursor: requestNextCursor,
  generated_at: "2026-09-03T01:00:05Z",
};

const secondPage = {
  requests: [requestTwo],
  limit: 25,
  previous_cursor: requestPreviousCursor,
  generated_at: "2026-09-03T01:00:06Z",
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

async function mockRequestGateway(
  page: Page,
  respond: (call: RequestProjectionCall, index: number) => { body: unknown; status?: number },
): Promise<RequestProjectionCall[]> {
  const calls: RequestProjectionCall[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Promise<void> =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });

    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/admin/requests") {
      const call = {
        cursor: url.searchParams.get("cursor") ?? "",
        headers: request.headers(),
        url,
      };
      calls.push(call);
      const response = respond(call, calls.length - 1);
      return json(response.body, response.status);
    }

    if (request.resourceType() === "document" && url.pathname.startsWith("/app/")) {
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  return calls;
}

test("요청 탐색기 직접 접근과 새로고침에서 필터·커서·안전 상세를 유지한다", async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const calls = await mockRequestGateway(page, (call) => ({
    body: call.cursor === requestNextCursor ? secondPage : firstPage,
  }));

  await page.goto(
    `observability/requests?model=gpt-test&status=success&provider_ref=${providerRef}&limit=25&tz=UTC&prompt=private`,
  );

  await expect(page.getByRole("heading", { name: "요청 탐색기", exact: true })).toBeVisible();
  await expect(page.getByLabel("모델", { exact: true })).toHaveValue("gpt-test");
  await expect(page.getByRole("combobox", { name: "상태", exact: true })).toHaveValue("success");
  await expect(page.getByLabel("공급자 참조", { exact: true })).toHaveValue(providerRef);
  await expect(page.getByLabel("시간대", { exact: true })).toHaveValue("UTC");
  await expect(page).toHaveURL(
    new RegExp(
      `/app/observability/requests\\?model=gpt-test&status=success&provider_ref=${providerRef}&limit=25&tz=UTC$`,
    ),
  );
  await expect(page.getByText("req-001", { exact: true })).toBeVisible();
  const expectedListTime = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(requestOne.created_at));
  const expectedDetailTime = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(requestOne.created_at));
  const expectedGeneratedTime = new Intl.DateTimeFormat("ko-KR", {
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(firstPage.generated_at));
  await expect(page.getByTestId("request-created-at-req-001")).toHaveText(expectedListTime);
  await expect(page.getByTestId("requests-generated-at")).toHaveText(expectedGeneratedTime);
  await expect(page.getByRole("link", { name: "기존 화면 보기" })).toHaveAttribute(
    "href",
    "/admin#/requests",
  );

  await expect.poll(() => calls.length).toBeGreaterThan(0);
  const initialCall = calls[0];
  expect(initialCall?.headers["x-vibe-ui"]).toBe("app");
  expect(initialCall?.headers["x-vibe-ui-version"]).toBeTruthy();
  expect(initialCall?.headers["x-vibe-route"]).toBe("observability.requests");
  expect(initialCall?.url.searchParams.get("model")).toBe("gpt-test");
  expect(initialCall?.url.searchParams.get("status")).toBe("success");
  expect(initialCall?.url.searchParams.get("provider_ref")).toBe(providerRef);
  expect(initialCall?.url.searchParams.get("tz")).toBe("UTC");
  expect(initialCall?.url.searchParams.has("prompt")).toBe(false);

  await page.reload();
  await expect(page.getByRole("heading", { name: "요청 탐색기", exact: true })).toBeVisible();
  await expect(page.getByText("req-001", { exact: true })).toBeVisible();
  await expect.poll(() => calls.length).toBeGreaterThan(1);
  expect(calls.at(-1)?.url.searchParams.get("tz")).toBe("UTC");
  await expect(page.getByTestId("request-created-at-req-001")).toHaveText(expectedListTime);

  const detailTrigger = page.getByRole("button", { name: "상세" });
  await detailTrigger.click();
  const dialog = page.getByRole("dialog", { name: "요청 req-001" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("프롬프트, 응답 본문, 원시 오류와 사용자 에이전트");
  await expect(dialog.getByTestId("request-detail-created-at")).toHaveText(expectedDetailTime);
  await expect(dialog).not.toContainText("prompt-private-e2e");
  await expect(dialog).not.toContainText("raw-error-private-e2e");
  expect(await axeViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(detailTrigger).toBeFocused();

  await page.getByRole("button", { name: "다음" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("cursor")).toBe(requestNextCursor);
  await expect(page.getByText("req-002", { exact: true })).toBeVisible();
  await expect.poll(() => calls.some((call) => call.cursor === requestNextCursor)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("요청 목록 갱신 실패 시 마지막 정상 데이터를 유지하고 빈 결과를 구분한다", async ({ page }) => {
  let responseMode: "empty" | "error" | "success" = "success";
  await mockRequestGateway(page, () => {
    if (responseMode === "error") {
      return {
        status: 503,
        body: {
          error: {
            code: "request_list_unavailable",
            message: "요청 목록 갱신에 실패했습니다.",
            type: "server_error",
          },
          request_id: "req-list-refresh",
        },
      };
    }
    if (responseMode === "empty") {
      return { body: { ...firstPage, requests: [], next_cursor: undefined } };
    }
    return { body: firstPage };
  });

  await page.goto("observability/requests");
  await expect(page.getByText("req-001", { exact: true })).toBeVisible();

  responseMode = "error";
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  const staleNotice = page.getByRole("alert").filter({
    hasText: "갱신에 실패해 마지막 정상 데이터를 표시합니다.",
  });
  await expect(staleNotice).toBeVisible();
  await expect(staleNotice).toContainText("요청 ID: req-list-refresh");
  await expect(page.getByText("req-001", { exact: true })).toBeVisible();

  responseMode = "empty";
  await staleNotice.getByRole("button", { name: "재시도" }).click();
  await expect(page.getByText("조건에 맞는 요청이 없습니다. 기간이나 필터를 조정해 보세요.")).toBeVisible();
  await expect(page.getByText("req-001", { exact: true })).toBeHidden();
});
