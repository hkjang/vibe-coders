import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic responses only: this proves the screens, not the server's masking or scope.
const feature = (feature_id: string, app_path: string, title: string) => ({
  feature_id,
  title,
  app_path,
  legacy_path: "/admin#/requests",
  status: "preview",
  risk_level: "low",
  required_permission: "admin:read",
  read_only: false,
  enabled_roles: [] as string[],
  rollout_percent: 100,
  fallback_enabled: true,
  minimum_api_version: "v0.84.0",
  available: true,
});

const now = Date.parse("2026-11-05T07:30:00Z");

const summary = (id: string, overrides: Record<string, unknown> = {}) => ({
  request_id: id,
  request_ref: `req_${id.padEnd(22, "0").slice(0, 22)}.${"0".repeat(21)}`,
  request_filterable: true,
  trace_id: `trace-${id}`,
  trace_filterable: true,
  session_id: "session-1",
  api_key_id: "key-1",
  ip: "192.0.2.10",
  method: "POST",
  model: "합성-모델",
  provider_ref: `prv_${"a".repeat(43)}`,
  provider_display: "합성 공급자",
  endpoint: "/v1/chat/completions",
  stream: false,
  status_code: 200,
  latency_ms: 321,
  first_chunk_ms: 0,
  prompt_tokens: 12,
  completion_tokens: 34,
  total_tokens: 46,
  cached_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost: 1.5,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-11-05T07:29:00.000000000Z",
  ...overrides,
});

const preview = (id: string, input: string, output: Record<string, unknown>) => ({
  request_id: id,
  input: {
    state: "captured",
    role: "user",
    text: input,
    truncated: false,
    chars: input.length,
    message_count: 2,
  },
  output: {
    state: "captured",
    kind: "text",
    text: "",
    truncated: false,
    chars: 0,
    tool_names: [],
    finish_reason: "stop",
    ...output,
  },
});

const detail = (id: string, overrides: Record<string, unknown> = {}) => ({
  request_id: id,
  created_at: "2026-11-05T07:29:00.000000000Z",
  method: "POST",
  endpoint: "/v1/chat/completions",
  stream: false,
  status_code: 200,
  error: "",
  requested_model: "합성-모델",
  resolved_model: "합성-모델",
  provider: "합성 공급자",
  route_reason: "",
  failover: false,
  fallback_from: "",
  languages: ["sql"],
  prompt_tokens: 12,
  completion_tokens: 34,
  total_tokens: 46,
  cached_tokens: 0,
  reasoning_tokens: 0,
  token_source: "usage",
  estimated_cost: 1.5,
  currency: "KRW",
  latency_ms: 321,
  first_chunk_ms: 0,
  api_key_id: "key-1",
  client_ip: "192.0.2.10",
  user_agent: "합성 클라이언트",
  session_id: "session-1",
  trace_id: `trace-${id}`,
  input: {
    state: "captured",
    messages: [
      { role: "system", text: "시스템 지시 문장", chars: 8, truncated: false, original_kept: false },
      {
        role: "user",
        text: "전화 [REDACTED_PHONE_KR] 로 안내해 줘",
        chars: 20,
        truncated: false,
        original_kept: true,
      },
    ],
    omitted_messages: 0,
    tool_definitions: "",
  },
  output: {
    state: "captured",
    kind: "text",
    text: "```sql\nSELECT 1;\n```\n안내했습니다",
    chars: 24,
    truncated: false,
    tool_calls: [],
    finish_reason: "stop",
  },
  capture: { response_text: true, raw_prompts: true, response_max_bytes: 1_048_576 },
  masked: true,
  raw_allowed: true,
  ...overrides,
});

interface Gateway {
  capture: { response_text: boolean; raw_prompts: boolean; response_max_bytes: number };
  points: Record<string, unknown>[];
  calls: string[];
  reveals: number;
  rotations: unknown[];
  rotationStatus: number;
}

async function install(page: Page, rawView = true): Promise<Gateway> {
  const user = {
    id: "public-reader",
    email: "reader@example.invalid",
    name: "입출력 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.62",
    ui_version: "request-io-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/observability/io",
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
    capabilities: { raw_prompt_view: rawView },
    allowed_features: ["observability.io", "observability.xview", "system.secrets"],
    migration_registry: [
      feature("observability.io", "/app/observability/io", "입출력 모니터"),
      feature("observability.xview", "/app/observability/xview", "XView 실시간"),
      {
        ...feature("system.secrets", "/app/system/secrets", "비밀키 교체"),
        risk_level: "critical",
        required_permission: "admin:write",
        fallback_enabled: false,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  } as UiBootstrapResponse;
  const gateway: Gateway = {
    capture: { response_text: true, raw_prompts: true, response_max_bytes: 1_048_576 },
    points: [],
    calls: [],
    reveals: 0,
    rotations: [],
    rotationStatus: 200,
  };
  const rows = [
    summary("req-text"),
    summary("req-tool", { finish_reason: "tool_calls" }),
    summary("req-fail", { status_code: 429, completion_tokens: 0 }),
    summary("req-off"),
  ];
  const previews = [
    preview("req-text", "전화 [REDACTED_PHONE_KR] 로 안내해 줘", { text: "안내했습니다" }),
    preview("req-tool", "주문을 조회해 줘", { kind: "tool_calls", tool_names: ["search_orders"] }),
    preview("req-fail", "한도 초과 요청", { kind: "error", text: "rate limit reached" }),
    preview("req-off", "저장 안 된 응답", { state: "not_captured", kind: "none" }),
  ];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const path = url.pathname;
    gateway.calls.push(`${request.method()} ${path}${url.search}`);
    if (path === "/admin/ui-bootstrap") return route.fulfill({ json: bootstrap });
    if (path === "/auth/me") return route.fulfill({ json: user });
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    if (path === "/admin/requests")
      return route.fulfill({
        headers: { "X-Vibe-App-Requests-Version": "2" },
        json: { requests: rows, limit: 30, generated_at: "2026-11-05T07:30:00.000000000Z" },
      });
    if (path === "/admin/requests/io") {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      const known = previews.filter((item) => ids.includes(item.request_id));
      const generated = ids
        .filter((id) => !known.some((item) => item.request_id === id))
        .map((id) => preview(id, `입력 ${id}`, { text: `출력 ${id}` }));
      return route.fulfill({
        json: {
          previews: [...known, ...generated],
          capture: gateway.capture,
          generated_at: "2026-11-05T07:30:00Z",
        },
      });
    }
    const io = /^\/admin\/requests\/([^/]+)\/io$/u.exec(path);
    if (io) {
      if (url.searchParams.get("reveal") === "raw") {
        gateway.reveals += 1;
        return route.fulfill({
          json: detail(io[1] as string, {
            masked: false,
            input: {
              state: "captured",
              messages: [
                {
                  role: "user",
                  text: "전화 010-0000-0000 로 안내해 줘",
                  chars: 20,
                  truncated: false,
                  original_kept: true,
                },
              ],
              omitted_messages: 0,
              tool_definitions: "",
            },
          }),
        });
      }
      if (io[1] === "req-off")
        return route.fulfill({
          json: detail("req-off", {
            output: {
              state: "not_captured",
              kind: "none",
              text: "",
              chars: 0,
              truncated: false,
              tool_calls: [],
              finish_reason: "stop",
            },
            capture: { response_text: false, raw_prompts: false, response_max_bytes: 1_048_576 },
          }),
        });
      return route.fulfill({ json: detail(io[1] as string, { raw_allowed: rawView }) });
    }
    if (path === "/admin/saved-filters") return route.fulfill({ json: { filters: [] } });
    if (path === "/admin/scatter")
      return route.fulfill({
        json: {
          points: gateway.points,
          truncated: false,
          since: new Date(now - 3_600_000).toISOString(),
          server_time: new Date(now).toISOString(),
          cursor: { ingested_at: "2026-11-05T07:29:59.000000001Z", request_id: "cursor" },
        },
      });
    if (path === "/admin/xview/delta")
      return route.fulfill({
        json: {
          points: [],
          has_more: false,
          server_time: new Date(now).toISOString(),
          cursor: { ingested_at: "2026-11-05T07:29:59.000000001Z", request_id: "cursor" },
        },
      });
    if (path === "/admin/secrets/rotate") {
      gateway.rotations.push(request.postDataJSON());
      if (gateway.rotationStatus !== 200)
        return route.fulfill({
          status: gateway.rotationStatus,
          json: {
            error: {
              message: "rotation could not be confirmed",
              type: "server_error",
              code: "rotation_failed",
            },
          },
        });
      return route.fulfill({
        json: { status: "ok", rotated: { provider_configs: 2, sso_provider_config: 1 } },
      });
    }
    return route.fulfill({ json: {} });
  });
  return gateway;
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  return page.evaluate(async () =>
    (
      await (
        window as unknown as { axe: { run(root: Document): Promise<{ violations: { id: string }[] }> } }
      ).axe.run(document)
    ).violations.map((item) => item.id),
  );
}

const row = (page: Page, id: string) => page.locator(`button.io-row[data-request-id="${id}"]`);

test("입출력 모니터는 요청마다 입력과 출력을 함께 보여 주고 없는 이유를 말한다", async ({ page }) => {
  await install(page);
  await page.goto("/app/observability/io");

  await expect(row(page, "req-text")).toContainText("전화 [REDACTED_PHONE_KR] 로 안내해 줘");
  await expect(row(page, "req-text")).toContainText("안내했습니다");
  await expect(row(page, "req-tool")).toContainText("도구 호출: search_orders");
  await expect(row(page, "req-fail")).toContainText("rate limit reached");
  await expect(row(page, "req-off")).toContainText("응답 본문 미저장");
  await expect(page.getByText("응답 본문을 저장하지 않고 있어")).toHaveCount(0);

  const panel = page.getByRole("region", { name: "선택한 요청의 입력과 출력" });
  await row(page, "req-text").click();
  await expect(page).toHaveURL(/request_id=req-text/u);
  await expect(panel.getByRole("region", { name: "입력" })).toContainText(
    "전화 [REDACTED_PHONE_KR] 로 안내해 줘",
  );
  await expect(panel.getByRole("region", { name: "출력" })).toContainText("안내했습니다");
  await expect(panel.getByRole("region", { name: "출력" }).locator("pre")).toContainText("SELECT 1;");
  await expect(panel.getByText("민감정보 마스킹 적용")).toBeVisible();
  await expect(panel.getByText("시스템 지시 문장")).toBeHidden();
  await panel.getByText("시스템 지시 1건").click();
  await expect(panel.getByText("시스템 지시 문장")).toBeVisible();
});

test("검색어는 표시된 행만 거르고 주소에 남지 않으며 방향키로 요청을 옮겨 다닌다", async ({ page }) => {
  await install(page);
  await page.goto("/app/observability/io");
  await expect(row(page, "req-text")).toBeVisible();

  await page.getByRole("searchbox", { name: "표시된 요청에서 찾기" }).fill("search_orders");
  await expect(row(page, "req-tool")).toBeVisible();
  await expect(row(page, "req-text")).toHaveCount(0);
  expect(page.url()).not.toContain("search_orders");
  await page.getByRole("searchbox", { name: "표시된 요청에서 찾기" }).fill("");

  await row(page, "req-text").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/request_id=req-tool/u);
  await expect(row(page, "req-tool")).toBeFocused();
  await expect(row(page, "req-tool")).toHaveAttribute("aria-current", "true");
});

test("원문 보기는 확인을 거쳐 한 번만 요청하고 다른 요청으로 옮기면 지워진다", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("/app/observability/io?request_id=req-text");
  const panel = page.getByRole("region", { name: "선택한 요청의 입력과 출력" });
  await expect(panel.getByText("민감정보 마스킹 적용")).toBeVisible();
  expect(gateway.reveals).toBe(0);

  await panel.getByRole("button", { name: "원문 보기" }).click();
  const dialog = page.getByRole("dialog", { name: "이 요청의 원문을 볼까요?" });
  await expect(dialog).toContainText("감사 기록");
  expect(gateway.reveals).toBe(0);
  await dialog.getByRole("button", { name: "원문 보기" }).click();
  await expect(panel.getByText("010-0000-0000")).toBeVisible();
  await expect(panel.getByText("원문 표시 중")).toBeVisible();
  expect(gateway.reveals).toBe(1);
  expect(page.url()).not.toContain("010-0000-0000");

  await row(page, "req-tool").click();
  await expect(panel.getByText("민감정보 마스킹 적용")).toBeVisible();
  await expect(page.getByText("010-0000-0000")).toHaveCount(0);
  expect(gateway.reveals).toBe(1);
});

test("원문 권한이 없으면 원문 보기를 내놓지 않는다", async ({ page }) => {
  await install(page, false);
  await page.goto("/app/observability/io?request_id=req-text");
  const panel = page.getByRole("region", { name: "선택한 요청의 입력과 출력" });
  await expect(panel.getByText("민감정보 마스킹 적용")).toBeVisible();
  await expect(panel.getByRole("button", { name: "원문 보기" })).toHaveCount(0);
});

test("응답 저장이 꺼져 있으면 왜 출력이 비었는지 알리고 설정으로 이어 준다", async ({ page }) => {
  const gateway = await install(page);
  gateway.capture = { response_text: false, raw_prompts: false, response_max_bytes: 1_048_576 };
  await page.goto("/app/observability/io?request_id=req-off");
  await expect(page.getByText("응답 본문을 저장하지 않고 있어 출력이 비어 보입니다.")).toBeVisible();
  const panel = page.getByRole("region", { name: "선택한 요청의 입력과 출력" });
  await expect(panel.getByText("응답 본문을 저장하지 않은 요청입니다.")).toBeVisible();
  await expect(panel.getByRole("link", { name: "저장 설정 열기" })).toHaveAttribute(
    "href",
    /system\/settings\?tab=runtime&q=logging\.response_text/u,
  );
});

test("입출력 모니터는 390px 어두운 화면에서 시트로 열리고 접근성 위반이 없다", async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/observability/io");
  await expect(row(page, "req-text")).toContainText("안내했습니다");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await row(page, "req-text").click();
  const sheet = page.getByRole("dialog", { name: "요청 입력과 출력" });
  await expect(sheet.getByRole("region", { name: "입력" })).toBeVisible();
  await expect(sheet.getByRole("region", { name: "출력" })).toContainText("안내했습니다");
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/request_id=/u);
});

test("입출력 모니터는 넓은 밝은 화면에서 접근성 위반이 없다", async ({ page }) => {
  await install(page);
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/observability/io?request_id=req-text");
  await expect(page.getByRole("region", { name: "출력", exact: true })).toContainText("안내했습니다");
  expect(await axeViolations(page)).toEqual([]);
});

const scatterPoint = (id: string, offsetMs: number, overrides: Record<string, unknown> = {}) => ({
  request_id: id,
  trace_id: `trace-${id}`,
  created_at: new Date(now - offsetMs).toISOString(),
  ingested_at: "2026-11-05T07:29:59.000000001Z",
  latency_ms: 200 + (offsetMs % 900),
  first_chunk_ms: 0,
  status_code: 200,
  provider: "합성 공급자",
  model: "합성-모델",
  endpoint: "/v1/chat/completions",
  total_tokens: 40,
  cost_krw: 1,
  ...overrides,
});

test("XView는 첫 화면에 산점도를 보여 주고 점을 누르면 입력과 출력을 연다", async ({ page }) => {
  const gateway = await install(page);
  gateway.points = [
    scatterPoint("point-ok", 600_000),
    scatterPoint("point-slow", 300_000, { latency_ms: 4_000 }),
    scatterPoint("point-fail", 60_000, { status_code: 500, latency_ms: 40 }),
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/observability/xview");
  const plot = page.getByRole("img", { name: /분포 산점도/u });
  await expect(plot).toBeInViewport();
  await expect(page.getByRole("heading", { name: "방금 들어온 요청" })).toBeVisible();
  await expect(page.getByRole("button", { name: "point-fail 입출력 열기" })).toContainText("출력 point-fail");

  // Three requests must not cost one DOM node per request and its tooltip.
  expect(await plot.locator("title").count()).toBe(1);

  await expect(page.locator(".obs-scatter-axis", { hasText: /^16:2\d$/u }).first()).toBeVisible();
  await expect(page.locator(".obs-scatter-axis", { hasText: /^P95 /u })).toBeVisible();

  const box = await plot.boundingBox();
  if (!box) throw new Error("plot has no box");
  let hit = false;
  for (let x = 0.99; x > 0.05 && !hit; x -= 0.01) {
    for (let y = 0.05; y < 0.95 && !hit; y += 0.03) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
      hit = (await page.locator(".obs-scatter-tooltip").count()) > 0;
    }
  }
  expect(hit).toBe(true);
  await expect(page.locator(".obs-scatter-tooltip")).toContainText("합성-모델");
  await page.mouse.down();
  await page.mouse.up();
  const sheet = page.getByRole("dialog", { name: "요청 입력과 출력" });
  await expect(sheet.getByRole("region", { name: "출력" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("XView 범례로 상태를 끄면 주소에 남고 드래그 선택에서도 빠진다", async ({ page }) => {
  const gateway = await install(page);
  gateway.points = [
    scatterPoint("point-ok", 600_000),
    scatterPoint("point-fail", 60_000, { status_code: 500 }),
  ];
  await page.goto("/app/observability/xview");
  const toggle = page.getByRole("button", { name: /^정상 1$/u });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/hide=normal/u);
  await page.reload();
  await expect(page.getByRole("button", { name: /^정상 1$/u })).toHaveAttribute("aria-pressed", "false");

  const plot = page.getByRole("img", { name: /분포 산점도/u });
  const box = await plot.boundingBox();
  if (!box) throw new Error("plot has no box");
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "요청 입력과 출력" })).toBeVisible();
});

test("XView 선택 목록은 요약과 함께 오류부터 보여 주고 행을 나눠 그린다", async ({ page }) => {
  const gateway = await install(page);
  gateway.points = Array.from({ length: 150 }, (_, index) =>
    scatterPoint(`point-${index}`, 1_000 * (index + 1)),
  );
  gateway.points.push(scatterPoint("point-fail", 500, { status_code: 500, latency_ms: 40 }));
  await page.goto("/app/observability/xview");
  await page.getByRole("button", { name: "오류 요청 보기" }).click();
  const errors = page.getByRole("dialog", { name: "선택한 요청 1건" });
  await expect(errors).toContainText("1건 (100.0%)");
  await page.keyboard.press("Escape");

  const plot = page.getByRole("img", { name: /분포 산점도/u });
  const box = await plot.boundingBox();
  if (!box) throw new Error("plot has no box");
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 4 });
  await page.mouse.up();
  const sheet = page.getByRole("dialog", { name: "선택한 요청 151건" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("tbody tr")).toHaveCount(100);
  await expect(sheet.locator("tbody tr").first()).toContainText("HTTP 500");
  await sheet.getByRole("button", { name: "51건 더 보기" }).click();
  await expect(sheet.locator("tbody tr")).toHaveCount(151);
});

test("비밀키 교체는 사전 점검과 재입력을 거쳐 한 번만 보내고 키를 남기지 않는다", async ({ page }) => {
  const gateway = await install(page);
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await page.goto("/app/system/secrets");
  const run = page.getByRole("button", { name: "비밀키 교체 실행" });
  await expect(run).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);

  const secret = "synthetic-rotation-secret-0123456789";
  await expect(page.getByRole("checkbox")).toHaveCount(4);
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  const inputs = page.locator('input[autocomplete="new-password"]');
  await inputs.nth(0).fill(secret);
  await expect(run).toBeDisabled();
  await inputs.nth(1).fill(secret);
  await expect(run).toBeEnabled();
  await run.click();

  const dialog = page.getByRole("dialog", { name: "게이트웨이 비밀키를 교체할까요?" });
  await dialog.getByRole("textbox").fill("비밀키 교체");
  await dialog.getByRole("button", { name: "교체 실행" }).click();
  await expect(page.getByText("저장된 비밀값을 새 키로 다시 암호화했습니다.")).toBeVisible();
  await expect(page.getByRole("row", { name: /공급자 API 키 2/u })).toBeVisible();
  expect(gateway.rotations).toEqual([{ new_secret: secret }]);
  expect(page.url()).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
    secret,
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("비밀키 교체 결과가 불확실하면 다시 실행하지 말라고 안내한다", async ({ page }) => {
  const gateway = await install(page);
  gateway.rotationStatus = 500;
  await page.goto("/app/system/secrets");
  const secret = "synthetic-rotation-secret-0123456789";
  await expect(page.getByRole("checkbox")).toHaveCount(4);
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  const inputs = page.locator('input[autocomplete="new-password"]');
  await inputs.nth(0).fill(secret);
  await inputs.nth(1).fill(secret);
  await page.getByRole("button", { name: "비밀키 교체 실행" }).click();
  const dialog = page.getByRole("dialog", { name: "게이트웨이 비밀키를 교체할까요?" });
  await dialog.getByRole("textbox").fill("비밀키 교체");
  await dialog.getByRole("button", { name: "교체 실행" }).click();
  await expect(page.getByText("교체 결과를 확인할 수 없습니다. 다시 실행하지 마세요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "비밀키 교체 실행" })).toHaveCount(0);
  expect(gateway.rotations).toHaveLength(1);
});
