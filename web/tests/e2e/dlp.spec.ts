import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic responses only: this proves the screens, not the server's detectors.
// Every value below is made up; the events carry only masked previews and fingerprints,
// which is all the gateway ever stores.
const feature = {
  feature_id: "security.dlp",
  title: "데이터 유출 방지",
  app_path: "/app/dlp",
  legacy_path: "/admin#/security",
  status: "preview",
  risk_level: "high",
  required_permission: "security:read",
  read_only: false,
  enabled_roles: [] as string[],
  rollout_percent: 100,
  fallback_enabled: false,
  minimum_api_version: "v0.86.183",
  available: true,
};

const policy = (id: string, name: string, action: string, profiles: string[], check: string[]) => ({
  id,
  name,
  enabled: true,
  action,
  profiles,
  check,
  teams: [] as string[],
  api_keys: [] as string[],
  note: "",
});

const recommended = [
  policy("mask-credentials", "자격 증명은 가리고 보내기", "MASK", ["credentials"], ["REQUEST"]),
  policy("block-government-ids", "주민·여권 번호가 든 프롬프트 차단", "BLOCK", ["government"], ["REQUEST"]),
  policy(
    "flag-personal-data",
    "개인·금융·의료 정보 기록",
    "FLAG",
    ["pii", "financial", "health", "pii_record"],
    ["REQUEST", "RESPONSE"],
  ),
];

const entry = (id: string, name: string, base: string, example: string) => ({
  id,
  name,
  description: "",
  base_confidence: base,
  requires_context: base === "none",
  context: [] as string[],
  mask: `[REDACTED_${id.toUpperCase()}]`,
  example,
});

const profile = (id: string, name: string, entries: ReturnType<typeof entry>[], record = 0) => ({
  id,
  name,
  description: "",
  default_min_confidence: id === "credentials" ? "low" : "medium",
  default_min_matches: 1,
  record_distinct: record,
  record_window: record ? 512 : 0,
  entries,
});

const catalog = [
  profile("credentials", "자격 증명·비밀", [entry("openai_api_key", "OpenAI API 키", "high", "sk-EXAMPLE")]),
  profile("financial", "금융 정보", [entry("credit_card", "카드 번호", "high", "4111 1111 1111 1111")]),
  profile("government", "정부 식별번호", [
    entry("kr_rrn", "주민·외국인등록번호", "medium", "900101-1234561"),
  ]),
  profile("pii", "개인 식별 정보", [
    entry("email", "이메일 주소", "high", "kim.minsu@example.com"),
    entry("kr_mobile", "휴대전화 번호", "high", "010-1234-5678"),
  ]),
  profile("health", "의료 정보", [entry("diagnosis_code", "진단 코드(ICD-10/KCD)", "none", "E11.9")]),
  profile("pii_record", "개인정보 레코드", [], 3),
];

interface Gateway {
  saves: {
    config: { enabled: boolean; policies: { id: string; action: string }[] };
    expected_revision: number;
  }[];
  tests: { text: string; config?: { policies: { id: string }[] } }[];
  eventQueries: string[];
}

async function install(page: Page): Promise<Gateway> {
  const gateway: Gateway = { saves: [], tests: [], eventQueries: [] };
  let revision = 0;
  let config = {
    enabled: false,
    evidence: "partial",
    max_scan_bytes: 262144,
    oversize: "allow",
    profiles: {},
    custom_profiles: [] as unknown[],
    policies: [] as unknown[],
  };
  const user = {
    id: "security-operator",
    email: "security@example.invalid",
    name: "보안 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["security:read", "admin:read", "admin:write"],
  };
  const bootstrap = {
    backend_version: "v0.86.183",
    ui_version: "dlp-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/dlp",
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
    allowed_features: ["security.dlp"],
    migration_registry: [feature],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  } as UiBootstrapResponse;
  const settings = () => ({
    config,
    revision,
    updated_by: revision ? "security-operator" : "",
    updated_at: revision ? "2026-11-26T01:00:00Z" : "",
    catalog,
    recommended_policies: recommended,
    response_header: "X-Vibe-DLP",
    compat_header: "cf-aig-dlp",
  });
  const events = [
    {
      id: "dlp_1",
      request_id: "req-flag-1",
      api_key_id: "key_support",
      user_id: "",
      team_id: "support",
      check: "REQUEST",
      action: "FLAG",
      policy_ids: ["flag-personal-data"],
      profile_id: "pii",
      entry_ids: ["email", "kr_mobile"],
      match_count: 2,
      confidence: "high",
      evidence: ["k•••@e•••.com (21자)", "010•••78 (13자)"],
      hashes: ["0f3c2a9d1b7e4c55", "9a8b7c6d5e4f3a2b"],
      endpoint: "/v1/chat/completions",
      model: "gpt-4.1-mini",
      created_at: "2026-11-26T00:30:00Z",
    },
    {
      id: "dlp_2",
      request_id: "req-block-1",
      api_key_id: "",
      user_id: "",
      team_id: "",
      check: "REQUEST",
      action: "BLOCK",
      policy_ids: ["block-government-ids"],
      profile_id: "government",
      entry_ids: ["kr_rrn"],
      match_count: 1,
      confidence: "high",
      evidence: [],
      hashes: ["5e4f3a2b1c0d9e8f"],
      endpoint: "/v1/chat/completions",
      model: "gpt-4.1",
      created_at: "2026-11-26T00:20:00Z",
    },
  ];
  await page.route("**/*", async (intercepted) => {
    const request = intercepted.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return intercepted.continue();
    const path = url.pathname;
    if (path === "/admin/ui-bootstrap") return intercepted.fulfill({ json: bootstrap });
    if (path === "/auth/me") return intercepted.fulfill({ json: user });
    if (path === "/health") return intercepted.fulfill({ json: { status: "ok" } });
    if (path === "/admin/security/dlp" && request.method() === "GET")
      return intercepted.fulfill({ json: settings() });
    if (path === "/admin/security/dlp" && request.method() === "PUT") {
      const body = request.postDataJSON() as Gateway["saves"][number];
      gateway.saves.push(body);
      config = body.config as typeof config;
      revision += 1;
      return intercepted.fulfill({
        json: { config, revision, updated_by: user.id, updated_at: "2026-11-26T01:00:00Z" },
      });
    }
    if (path === "/admin/security/dlp/test") {
      const body = request.postDataJSON() as Gateway["tests"][number];
      gateway.tests.push(body);
      const encoder = new TextEncoder();
      const find = (value: string) => {
        const at = body.text.indexOf(value);
        const start = encoder.encode(body.text.slice(0, at)).length;
        return { start, end: start + encoder.encode(value).length };
      };
      return intercepted.fulfill({
        json: {
          matches: [
            {
              profile_id: "government",
              entry_id: "kr_rrn",
              entry_name: "주민·외국인등록번호",
              ...find("900101-1234561"),
              confidence: "high",
            },
            {
              profile_id: "pii",
              entry_id: "kr_mobile",
              entry_name: "휴대전화 번호",
              ...find("010-1234-5678"),
              confidence: "high",
            },
          ],
          profiles: [
            {
              profile_id: "government",
              name: "정부 식별번호",
              triggered: true,
              match_count: 1,
              entry_ids: ["kr_rrn"],
            },
            {
              profile_id: "pii",
              name: "개인 식별 정보",
              triggered: true,
              match_count: 1,
              entry_ids: ["kr_mobile"],
            },
          ],
          truncated: false,
          scanned_bytes: encoder.encode(body.text).length,
          request: {
            action: "BLOCK",
            policies: [
              { policy_id: "block-government-ids", action: "BLOCK", profiles: ["government"] },
              { policy_id: "flag-personal-data", action: "FLAG", profiles: ["pii"] },
            ],
          },
          response: {
            action: "FLAG",
            policies: [{ policy_id: "flag-personal-data", action: "FLAG", profiles: ["pii"] }],
          },
          masked_request: "",
          header: JSON.stringify({ action: "BLOCK" }),
        },
      });
    }
    if (path === "/admin/security/dlp/events") {
      gateway.eventQueries.push(url.search);
      const action = url.searchParams.get("action");
      const rows = action ? events.filter((event) => event.action === action) : events;
      return intercepted.fulfill({
        json: {
          events: rows,
          summary: {
            by_action: [
              { key: "FLAG", events: 1, requests: 1, matches: 2 },
              { key: "BLOCK", events: 1, requests: 1, matches: 1 },
            ],
            by_check: [{ key: "REQUEST", events: 2, requests: 2, matches: 3 }],
            by_profile: [
              { key: "pii", events: 1, requests: 1, matches: 2 },
              { key: "government", events: 1, requests: 1, matches: 1 },
            ],
            by_day: [{ key: "2026-11-26", events: 2, requests: 2, matches: 3 }],
          },
          hours: Number(url.searchParams.get("hours") ?? 24),
          count: rows.length,
        },
      });
    }
    return intercepted.fulfill({
      status: 404,
      json: { error: { message: "not mocked", type: "invalid_request_error", code: "not_found" } },
    });
  });
  return gateway;
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test("starts from the recommended policies, checks a sample and saves on the loaded revision", async ({
  page,
}) => {
  const gateway = await install(page);
  await page.goto("dlp");
  await expect(page.getByRole("heading", { name: "데이터 유출 방지" })).toBeVisible();
  await expect(page.getByText("아직 정책이 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: /권장 정책 추가/u }).click();
  const policies = page.getByRole("list", { name: "DLP 정책 목록" });
  await expect(policies.getByRole("listitem")).toHaveCount(3);

  // Tighten the credentials policy from masking to blocking.
  await page.getByRole("button", { name: "자격 증명은 가리고 보내기 편집" }).click();
  const dialog = page.getByRole("dialog", { name: "정책 편집" });
  await dialog.getByRole("radio", { name: /BLOCK/u }).check();
  await dialog.getByRole("button", { name: "적용" }).click();
  await expect(dialog).toHaveCount(0);

  // The test scan runs against the unsaved draft.
  await page.getByRole("tab", { name: "테스트 스캔" }).click();
  await page.getByRole("button", { name: "고객 상담 기록" }).click();
  await page.getByRole("button", { name: "검사", exact: true }).click();
  const marked = page.getByLabel("찾은 위치가 표시된 텍스트");
  await expect(marked.locator("mark")).toHaveCount(2);
  await expect(marked.locator("mark").first()).toContainText("900101-1234561");
  await expect(page.getByText("block-government-ids")).toBeVisible();
  expect(gateway.tests[0]?.config?.policies.map((p) => p.id)).toEqual([
    "mask-credentials",
    "block-government-ids",
    "flag-personal-data",
  ]);

  await page.getByRole("tab", { name: "개요" }).click();
  await page.getByRole("switch", { name: /DLP 꺼짐/u }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("버전 1", { exact: true })).toBeVisible();

  expect(gateway.saves).toHaveLength(1);
  const saved = gateway.saves[0];
  expect(saved?.expected_revision).toBe(0);
  expect(saved?.config.enabled).toBe(true);
  expect(saved?.config.policies.map((p) => [p.id, p.action])).toEqual([
    ["mask-credentials", "BLOCK"],
    ["block-government-ids", "BLOCK"],
    ["flag-personal-data", "FLAG"],
  ]);
  await noSidewaysScroll(page);
});

test("filters events and shows only masked previews and fingerprints", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("dlp?tab=events");
  const table = page.getByRole("table", { name: "DLP 탐지 이벤트" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByText("k•••@e•••.com (21자)")).toBeVisible();
  await expect(table.getByText("지문 1개")).toBeVisible();
  await expect(table.getByRole("link", { name: "요청 req-flag-1 입출력 보기" })).toHaveAttribute(
    "href",
    /request_id=req-flag-1/u,
  );

  await page.getByRole("combobox", { name: "동작" }).selectOption("BLOCK");
  await expect.poll(() => gateway.eventQueries.at(-1)).toContain("action=BLOCK");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(page).toHaveURL(/action=BLOCK/u);
  await expect(page.getByText("탐지 이벤트를 불러오지 못했습니다.")).toHaveCount(0);
});

test("keeps every tab usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await install(page);
  await page.goto("dlp");
  await page.getByRole("button", { name: /권장 정책 추가/u }).click();
  for (const tab of ["개요", "정책", "프로필", "테스트 스캔", "탐지 이벤트"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await noSidewaysScroll(page);
  }
});

test("summarises changes, saves with Ctrl+S, warns before leaving and tries an example", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("dlp");
  await page.getByRole("button", { name: /권장 정책 추가/u }).click();
  await expect(page.getByText(/변경 3건: 정책 추가: 자격 증명은 가리고 보내기/u)).toBeVisible();

  // Closing the tab with unsaved changes asks first.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toContain("beforeunload");
  expect(page.isClosed()).toBe(false);

  await page.keyboard.press("Control+s");
  await expect(page.getByText("버전 1", { exact: true })).toBeVisible();
  expect(gateway.saves).toHaveLength(1);
  await expect(page.getByText(/변경 \d+건/u)).toHaveCount(0);

  await page.getByRole("tab", { name: "프로필" }).click();
  await page.getByRole("searchbox", { name: /탐지 항목 찾기/u }).fill("주민");
  await page.getByRole("button", { name: "주민·외국인등록번호 예시로 테스트 스캔 (정부 식별번호)" }).click();
  await expect(page.getByRole("tab", { name: "테스트 스캔" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("찾은 위치가 표시된 텍스트")).toBeVisible();
  expect(gateway.tests.at(-1)?.text).toBe("900101-1234561");
});
