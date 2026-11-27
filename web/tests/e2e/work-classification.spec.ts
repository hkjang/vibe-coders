import { expect, test, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Synthetic gateway: this proves the classification console's screens and the
// requests they send, not the server's classifier. Every request title, team and
// number below is made up.
const feature = {
  feature_id: "insights.classification",
  title: "업무 분류 관리",
  app_path: "/app/insights/classification",
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

interface Category {
  id: string;
  parent_id: string;
  name: string;
  description: string;
  examples: string[];
  enabled: boolean;
  merged_into: string;
  rules: {
    keywords: string[];
    mcp_servers: string[];
    mcp_tools: string[];
    languages: string[];
    task_types: string[];
    clients: string[];
    weight: number;
  };
}

interface Config {
  categories: Category[];
  action_types: { id: string; name: string; keywords: string[] }[];
  thresholds: { accept: number; review_below: number; min_evidence: number; min_group_size: number };
  llm: { system_prompt: string; max_input_chars: number };
  baselines: unknown[];
}

const category = (id: string, name: string, keywords: string[] = []): Category => ({
  id,
  parent_id: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "",
  name,
  description: "",
  examples: [],
  enabled: true,
  merged_into: "",
  rules: { keywords, mcp_servers: [], mcp_tools: [], languages: [], task_types: [], clients: [], weight: 1 },
});

const initialConfig = (): Config => ({
  categories: [
    category("dev", "소프트웨어 개발"),
    category("dev.codegen", "코드 생성", ["함수", "api"]),
    category("dev.review", "코드 리뷰", ["리뷰"]),
    category("infra", "IT 인프라 운영"),
    category("infra.k8s", "쿠버네티스 운영", ["파드", "kubectl"]),
    category("itsm", "IT 서비스 운영"),
    category("security", "정보보호"),
    category("data", "데이터 분석"),
    category("office", "일반 사무"),
    category("planning", "경영 및 기획"),
    category("support", "고객 지원"),
    category("knowledge", "지식 관리"),
    category("ai", "AI 개발"),
    category("automation", "업무 자동화"),
    category("other", "기타 및 미분류"),
  ],
  action_types: [
    { id: "create", name: "생성", keywords: ["만들어", "create"] },
    { id: "analyze", name: "분석", keywords: ["분석"] },
  ],
  thresholds: { accept: 0.72, review_below: 0.5, min_evidence: 2, min_group_size: 3 },
  llm: { system_prompt: "요청을 등록된 업무 카테고리 중 하나로 분류하세요.", max_input_chars: 1500 },
  baselines: [],
});

const categoryRef = (id: string, name: string) => ({
  id,
  name,
  level: id.split(".").length,
  parent_id: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "",
  top_id: id.split(".")[0],
  enabled: true,
});

const reviewRow = (id: string, title: string, status: string, confidence: number) => ({
  request_id: id,
  created_at: "2026-11-26T02:00:00Z",
  session_id: `sess_${id}`,
  team: "platform",
  user: "",
  client: "Claude Code",
  model: "gpt-4.1",
  category: categoryRef("other", "기타 및 미분류"),
  action_type: "unknown",
  confidence,
  method: "rule",
  status,
  work_title: title,
  tags: ["배포", "릴리스"],
  technologies: [] as string[],
  tokens: 1200,
  cost_krw: 14,
  latency_ms: 900,
  is_error: false,
  policy_version: 2,
});

interface Gateway {
  saves: { config: Config; expected_revision: number; reason: string }[];
  publishes: { expected_revision: number; note: string }[];
  reviewQueries: string[];
  corrections: { request_ids: string[]; category_id: string; action_type?: string; reason: string }[];
  previews: string[];
  runs: { search: string; body: { revision: string; reviewed_at: string; reason: string } }[];
  jobPolls: number;
}

async function install(page: Page): Promise<Gateway> {
  const gateway: Gateway = {
    saves: [],
    publishes: [],
    reviewQueries: [],
    corrections: [],
    previews: [],
    runs: [],
    jobPolls: 0,
  };
  let config = initialConfig();
  let revision = 4;
  let publishedVersion = 2;
  let dirty = false;
  const published = new Map<number, Config>([[2, initialConfig()]]);
  const versions = [
    {
      version: 2,
      note: "쿠버네티스 운영 분리",
      published_by: "work-admin",
      published_at: "2026-11-25T01:00:00Z",
      categories: 15,
      changes: { added: ["infra.k8s"], removed: [], renamed: [], merged: [], rules_changed: ["dev.codegen"] },
    },
    {
      version: 1,
      note: "첫 배포",
      published_by: "work-admin",
      published_at: "2026-11-20T01:00:00Z",
      categories: 14,
      changes: { added: [], removed: [], renamed: [], merged: [], rules_changed: [] },
    },
  ];
  let queue = [
    reviewRow("req-1", "배포 스크립트 수정 요청", "review", 0.41),
    reviewRow("req-2", "릴리스 노트 정리", "unclassified", 0.18),
    reviewRow("req-3", "점심 메뉴 추천", "unclassified", 0.05),
    reviewRow("req-4", "장애 보고서 초안", "review", 0.47),
  ];

  const user = {
    id: "work-admin",
    email: "work-admin@example.invalid",
    name: "분류 검증",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap = {
    backend_version: "v0.86.186",
    ui_version: "work-classification-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/insights/classification",
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
    allowed_features: ["insights.classification"],
    migration_registry: [feature],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  } as UiBootstrapResponse;

  const policy = () => ({
    config,
    revision,
    updated_by: "work-admin",
    updated_at: "2026-11-26T01:00:00Z",
    published_version: publishedVersion,
    published_at: "2026-11-25T01:00:00Z",
    dirty,
    defaults: { action_types: initialConfig().action_types, thresholds: initialConfig().thresholds },
  });
  const job = (status: string, done: number) => ({
    id: "job-1",
    status,
    actor: "work-admin",
    created_at: "2026-11-26T03:00:05Z",
    updated_at: "2026-11-26T03:00:10Z",
    progress: {
      total: 200,
      done,
      changed: Math.floor(done / 4),
      failed: 0,
      days_rebuilt: done === 200 ? 7 : 2,
    },
  });

  await page.route("**/*", async (intercepted) => {
    const request = intercepted.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return intercepted.continue();
    const path = url.pathname;
    const method = request.method();
    if (path === "/admin/ui-bootstrap") return intercepted.fulfill({ json: bootstrap });
    if (path === "/auth/me") return intercepted.fulfill({ json: user });
    if (path === "/health") return intercepted.fulfill({ json: { status: "ok" } });

    if (path === "/admin/work-intel/status") {
      return intercepted.fulfill({
        json: {
          classify_enabled: true,
          analytics_enabled: true,
          llm_enabled: false,
          llm_model: "",
          llm_external_allowed: false,
          policy_version: publishedVersion,
          cursor_at: "2026-11-26T02:59:30Z",
          lag_seconds: 95,
          backlog: 37,
          last_run_at: "2026-11-26T02:59:45Z",
          last_error: "",
          processed_total: 120000,
          processed_24h: 4200,
          by_method: { rule: 3000, cache: 900, llm: 250, manual: 50 },
          failures_24h: 3,
          llm_calls_24h: 260,
          llm_tokens_24h: 91000,
          llm_cost_krw_24h: 1840,
          cache_hits_24h: 900,
          worker_active: true,
        },
      });
    }
    if (path === "/admin/work-intel/policy" && method === "GET")
      return intercepted.fulfill({ json: policy() });
    if (path === "/admin/work-intel/policy" && method === "PUT") {
      const body = request.postDataJSON() as Gateway["saves"][number];
      gateway.saves.push(body);
      if (body.expected_revision !== revision) {
        return intercepted.fulfill({
          status: 409,
          json: {
            error: { message: "conflict", type: "invalid_request_error", code: "work_policy_conflict" },
          },
        });
      }
      config = body.config;
      revision += 1;
      dirty = true;
      return intercepted.fulfill({
        json: { config, revision, updated_by: user.id, updated_at: "2026-11-26T03:00:00Z" },
      });
    }
    if (path === "/admin/work-intel/policy/versions") return intercepted.fulfill({ json: { versions } });
    const versionMatch = /^\/admin\/work-intel\/policy\/versions\/(\d+)$/u.exec(path);
    if (versionMatch) {
      const version = Number(versionMatch[1]);
      const row = versions.find((item) => item.version === version);
      return intercepted.fulfill({
        json: {
          version,
          config: published.get(version) ?? initialConfig(),
          note: row?.note ?? "",
          published_by: row?.published_by ?? "",
          published_at: row?.published_at ?? "",
        },
      });
    }
    if (path === "/admin/work-intel/policy/publish") {
      const body = request.postDataJSON() as Gateway["publishes"][number];
      gateway.publishes.push(body);
      const before = new Set(
        (published.get(publishedVersion) ?? initialConfig()).categories.map((c) => c.id),
      );
      publishedVersion += 1;
      published.set(publishedVersion, config);
      dirty = false;
      versions.unshift({
        version: publishedVersion,
        note: body.note,
        published_by: user.id,
        published_at: "2026-11-26T03:05:00Z",
        categories: config.categories.length,
        changes: {
          added: config.categories.map((c) => c.id).filter((id) => !before.has(id)),
          removed: [],
          renamed: [],
          merged: [],
          rules_changed: [],
        },
      });
      return intercepted.fulfill({
        json: {
          version: publishedVersion,
          published_at: "2026-11-26T03:05:00Z",
          impact: { categories_removed: 0, affected_requests: 132 },
        },
      });
    }

    if (path === "/admin/work-intel/review" && method === "GET") {
      gateway.reviewQueries.push(url.search);
      const status = url.searchParams.get("status");
      const maxConf = url.searchParams.get("max_conf");
      const rows = queue.filter(
        (row) =>
          (!status || row.status === status) && (maxConf === null || row.confidence <= Number(maxConf)),
      );
      return intercepted.fulfill({
        json: {
          rows,
          count: rows.length,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
          summary: {
            review: queue.filter((row) => row.status === "review").length,
            unclassified: queue.filter((row) => row.status === "unclassified").length,
            failed: 0,
            new_category_hints: [{ hint: "릴리스 관리", count: 7 }],
          },
        },
      });
    }
    if (path === "/admin/work-intel/review/correct") {
      const body = request.postDataJSON() as Gateway["corrections"][number];
      gateway.corrections.push(body);
      queue = queue.filter((row) => !body.request_ids.includes(row.request_id));
      return intercepted.fulfill({
        json: { corrected: body.request_ids.length, days_rebuilt: ["2026-11-26"] },
      });
    }

    if (path === "/admin/work-intel/reclassify" && method === "GET") {
      gateway.previews.push(url.search);
      return intercepted.fulfill({
        json: {
          revision: "preview-rev-1",
          reviewed_at: "2026-11-26T03:00:00Z",
          expires_at: "2099-01-01T00:00:00Z",
          total: 200,
          by_status: { review: 150, unclassified: 50 },
          by_method: { rule: 180, llm: 20 },
          manual_kept: 12,
          est_llm_calls: 40,
          days: 7,
          active_job: null,
        },
      });
    }
    if (path === "/admin/work-intel/reclassify" && method === "POST") {
      gateway.runs.push({
        search: url.search,
        body: request.postDataJSON() as Gateway["runs"][number]["body"],
      });
      return intercepted.fulfill({ json: job("queued", 0) });
    }
    if (path === "/admin/work-intel/reclassify/jobs/job-1") {
      gateway.jobPolls += 1;
      // Running for the first two reads, then done.
      return intercepted.fulfill({
        json: gateway.jobPolls <= 2 ? job("running", gateway.jobPolls * 60) : job("succeeded", 200),
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

test("adds a child category, saves the draft on the loaded revision and publishes it", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("insights/classification?tab=categories&category=dev");
  await expect(page.getByRole("heading", { name: "업무 분류 관리" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "소프트웨어 개발" })).toBeVisible();

  await page.getByRole("button", { name: "하위 카테고리 추가" }).click();
  const add = page.getByRole("dialog", { name: "하위 카테고리 추가" });
  await add.getByLabel("이름").fill("API 설계");
  // The id is made from the name under the parent's id and can still be changed.
  await expect(add.getByLabel("ID")).toHaveValue("dev.api");
  await add.getByLabel("ID").fill("dev.api-design");
  await add.getByRole("button", { name: "추가" }).click();
  await expect(add).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "API 설계" })).toBeVisible();
  await expect(page).toHaveURL(/category=dev\.api-design/u);
  await page.getByLabel(/^키워드/u).fill("openapi, 엔드포인트");
  await expect(page.getByText("카테고리 추가 1")).toBeVisible();
  const tree = page.getByRole("navigation", { name: "카테고리 트리" });
  await expect(tree.getByText("저장 전")).toBeVisible();

  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("초안 리비전 5", { exact: true })).toBeVisible();
  expect(gateway.saves).toHaveLength(1);
  expect(gateway.saves[0]?.expected_revision).toBe(4);
  const saved = gateway.saves[0]?.config.categories.find((item) => item.id === "dev.api-design");
  expect(saved).toMatchObject({ parent_id: "dev", name: "API 설계", enabled: true });
  expect(saved?.rules.keywords).toEqual(["openapi", "엔드포인트"]);
  // Saved categories keep their id for good.
  await expect(tree.getByText("저장 전")).toHaveCount(0);
  await expect(page.getByLabel("ID", { exact: true })).toHaveAttribute("readonly", "");

  // Saving changed nothing for the classifier yet; publishing does.
  await page.getByRole("tab", { name: "정책·버전" }).click();
  await expect(page.getByText("초안이 배포본과 다름")).toBeVisible();
  await page.getByRole("button", { name: "배포", exact: true }).click();
  const publish = page.getByRole("dialog", { name: "정책 배포" });
  await expect(publish.getByText(/버전 2 대비 변경: 카테고리 추가 1/u)).toBeVisible();
  await expect(publish.getByText("추가: API 설계 (dev.api-design)")).toBeVisible();
  await publish.getByLabel("변경 사유").fill("API 설계 업무 분리");
  await publish.getByRole("button", { name: "배포", exact: true }).click();

  await expect(page.getByText("정책 버전 3 배포를 마쳤습니다.").first()).toBeVisible();
  await expect(page.getByText(/영향받는 요청\s*132건/u)).toBeVisible();
  expect(gateway.publishes).toEqual([{ expected_revision: 5, note: "API 설계 업무 분리" }]);
  const versions = page.getByRole("list", { name: "배포 버전 목록" });
  await expect(versions.getByRole("listitem")).toHaveCount(3);
  await expect(versions.getByRole("listitem").first()).toContainText("버전 3");
  await expect(versions.getByRole("listitem").first()).toContainText("현재 배포본");
  await expect(page.getByText("초안이 배포본과 같음")).toBeVisible();
  await noSidewaysScroll(page);
});

test("keeps the review filters in the URL across a reload and corrects several requests at once", async ({
  page,
}) => {
  const gateway = await install(page);
  await page.goto("insights/classification?tab=review");
  const table = page.getByRole("table", { name: "검토 대기열" });
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(page.getByText("릴리스 관리")).toBeVisible();

  await page.getByRole("combobox", { name: "상태" }).selectOption("unclassified");
  await expect(page).toHaveURL(/status=unclassified/u);
  await page.getByRole("combobox", { name: "신뢰도 상한" }).selectOption("0.3");
  await expect(page).toHaveURL(/max_conf=0\.3/u);
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect.poll(() => gateway.reviewQueries.at(-1)).toContain("status=unclassified");
  expect(gateway.reviewQueries.at(-1)).toContain("max_conf=0.3");

  await page.reload();
  await expect(page).toHaveURL(/status=unclassified/u);
  await expect(page).toHaveURL(/max_conf=0\.3/u);
  await expect(page.getByRole("combobox", { name: "상태" })).toHaveValue("unclassified");
  await expect(page.getByRole("combobox", { name: "신뢰도 상한" })).toHaveValue("0.3");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByText("배포 스크립트 수정 요청")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "릴리스 노트 정리 선택" }).check();
  await page.getByRole("checkbox", { name: "점심 메뉴 추천 선택" }).check();
  await expect(page.getByText(/이 페이지 2건 중 2건 선택/u)).toBeVisible();
  await page.getByRole("button", { name: "분류 보정" }).click();

  const dialog = page.getByRole("dialog", { name: "분류 보정" });
  await expect(dialog.getByText(/검증 데이터로 쌓여/u)).toBeVisible();
  await dialog.getByRole("searchbox", { name: "카테고리 찾기" }).fill("지식");
  await dialog.getByRole("radio", { name: /지식 관리/u }).check();
  await dialog.getByLabel("보정 사유").fill("문서 정리 업무");
  await dialog.getByRole("button", { name: "2건 보정" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByText("2건의 분류를 보정했습니다.").first()).toBeVisible();
  await expect(page.getByText("집계를 다시 만든 날짜: 2026-11-26")).toBeVisible();
  expect(gateway.corrections).toEqual([
    { request_ids: ["req-2", "req-3"], category_id: "knowledge", reason: "문서 정리 업무" },
  ]);
  // The corrected requests have left the queue; the filter is still in the URL.
  await expect(table.getByText("릴리스 노트 정리")).toHaveCount(0);
  await expect(page).toHaveURL(/status=unclassified/u);
});

test("previews a reclassification, runs it and follows the job to completion", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("insights/classification?tab=reclassify&from=2026-11-20&to=2026-11-26");
  const run = page.getByRole("button", { name: "재분류 실행" });
  await expect(run).toBeDisabled();
  await page.getByRole("combobox", { name: "상태" }).selectOption("review");
  await page.getByRole("button", { name: "영향 미리보기" }).click();

  const preview = page.getByRole("region", { name: "재분류 영향 미리보기" });
  await expect(preview.getByText("200건")).toBeVisible();
  await expect(preview.getByText("12건")).toBeVisible();
  await expect(preview.getByText("40회")).toBeVisible();
  expect(gateway.previews.at(-1)).toBe("?from=2026-11-20&to=2026-11-26&status=review");

  await run.click();
  const confirm = page.getByRole("dialog", { name: "재분류 실행" });
  await expect(confirm.getByText(/수동 보정 12건은 그대로 유지합니다/u)).toBeVisible();
  await confirm.getByLabel("변경 사유").fill("정책 버전 2 적용");
  await confirm.getByRole("button", { name: "재분류 시작" }).click();
  await expect(confirm).toHaveCount(0);

  const progress = page.getByRole("progressbar", { name: "재분류 진행률" });
  await expect(progress).toBeVisible();
  await expect(page).toHaveURL(/job=job-1/u);
  expect(gateway.runs).toEqual([
    {
      search: "?reviewed=1",
      body: { revision: "preview-rev-1", reviewed_at: "2026-11-26T03:00:00Z", reason: "정책 버전 2 적용" },
    },
  ]);

  await expect(page.getByText("재분류를 마쳤습니다.")).toBeVisible({ timeout: 20_000 });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByText("100% · 200 / 200건 처리")).toBeVisible();
  // A finished job is not polled any more.
  const polls = gateway.jobPolls;
  expect(polls).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(4_500);
  expect(gateway.jobPolls).toBe(polls);

  // The job is addressable: the same URL shows it again.
  await page.reload();
  await expect(page.getByText("재분류를 마쳤습니다.")).toBeVisible();
  await noSidewaysScroll(page);
});

test("keeps one draft across tabs, warns before leaving and saves with Ctrl+S", async ({ page }) => {
  const gateway = await install(page);
  await page.goto("insights/classification?tab=policy");
  await page.getByLabel("최소 근거 수").fill("3");
  await expect(page.getByText("임계값 변경")).toBeVisible();

  // Another tab edits the same draft: neither change is lost, and no prompt appears.
  await page.getByRole("tab", { name: "기준값", exact: true }).click();
  await page.getByLabel("기준값을 추가할 카테고리").selectOption("dev.codegen");
  await page.getByRole("button", { name: "기준값 추가" }).click();
  await expect(page.getByText("임계값 변경 · 기준값 변경 1")).toBeVisible();

  // Closing the browser tab with unsaved changes asks first.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toContain("beforeunload");
  expect(page.isClosed()).toBe(false);

  await page.keyboard.press("Control+s");
  await expect(page.getByText("초안 리비전 5", { exact: true })).toBeVisible();
  expect(gateway.saves).toHaveLength(1);
  expect(gateway.saves[0]?.expected_revision).toBe(4);
  expect(gateway.saves[0]?.config.thresholds.min_evidence).toBe(3);
  expect(gateway.saves[0]?.config.baselines).toEqual([
    { category_id: "dev.codegen", manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50000, note: "" },
  ]);
  await expect(page.getByText("새 변경사항이 없습니다.")).toBeVisible();
});

test("keeps every tab usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await install(page);
  await page.goto("insights/classification");
  await expect(page.getByText("37건")).toBeVisible();
  for (const tab of ["상태", "카테고리", "정책·버전", "테스트", "검토", "재분류", "기준값"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
    if (tab === "카테고리")
      await expect(page.getByRole("navigation", { name: "카테고리 트리" })).toBeVisible();
    if (tab === "정책·버전") await expect(page.getByRole("list", { name: "배포 버전 목록" })).toBeVisible();
    if (tab === "테스트") await expect(page.getByRole("button", { name: "분류", exact: true })).toBeVisible();
    if (tab === "검토") await expect(page.getByRole("table", { name: "검토 대기열" })).toBeVisible();
    if (tab === "재분류") await expect(page.getByRole("button", { name: "영향 미리보기" })).toBeVisible();
    if (tab === "기준값") await expect(page.getByText("아직 기준값이 없습니다.")).toBeVisible();
    await noSidewaysScroll(page);
  }

  // The editor of a deep category and an unsaved change (which grows the save bar) still fit.
  await page.getByRole("tab", { name: "카테고리", exact: true }).click();
  await page.getByRole("searchbox", { name: /카테고리 찾기/u }).fill("파드");
  await page.getByRole("navigation", { name: "카테고리 트리" }).getByText("쿠버네티스 운영").click();
  await expect(page.getByRole("heading", { name: "쿠버네티스 운영" })).toBeVisible();
  await page.getByLabel(/^키워드/u).fill("파드, kubectl, 헬름");
  await expect(page.getByText("규칙 변경 1")).toBeVisible();
  await noSidewaysScroll(page);
});
