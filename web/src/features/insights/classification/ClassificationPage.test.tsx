import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { mockApi, type ApiHandler } from "@/test/api";

import { ClassificationPage } from "./ClassificationPage";

let scopes = ["admin:read", "admin:write"];
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({ mode: "authenticated", user: { scopes } }),
}));

const api = "/admin/work-intel";
const route = "/insights/classification";

const rules = (extra: Record<string, unknown> = {}) => ({
  keywords: [] as string[],
  mcp_servers: [] as string[],
  mcp_tools: [] as string[],
  languages: [] as string[],
  task_types: [] as string[],
  clients: [] as string[],
  weight: 1,
  ...extra,
});

const category = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent_id: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "",
  name,
  description: "",
  examples: [] as string[],
  enabled: true,
  merged_into: "",
  rules: rules(),
  ...extra,
});

const topLevel = [
  category("dev", "소프트웨어 개발"),
  category("infra", "IT 인프라 운영"),
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
];

function config(extra: Record<string, unknown> = {}) {
  return {
    categories: [
      ...topLevel,
      category("dev.codegen", "코드 생성", { rules: rules({ keywords: ["함수", "api"] }) }),
      category("dev.review", "코드 리뷰"),
    ],
    action_types: [
      { id: "create", name: "생성", keywords: ["만들어", "create"] },
      { id: "analyze", name: "분석", keywords: ["분석"] },
    ],
    thresholds: { accept: 0.72, review_below: 0.5, min_evidence: 2, min_group_size: 3 },
    llm: { system_prompt: "요청을 업무 카테고리로 분류하세요.", max_input_chars: 1500 },
    baselines: [] as unknown[],
    ...extra,
  };
}

function policy(extra: Record<string, unknown> = {}) {
  return {
    config: config(),
    revision: 4,
    updated_by: "ops",
    updated_at: "2026-11-26T01:00:00Z",
    published_version: 2,
    published_at: "2026-11-25T01:00:00Z",
    dirty: false,
    defaults: {
      action_types: [{ id: "create", name: "생성", keywords: ["만들어"] }],
      thresholds: { accept: 0.72, review_below: 0.5, min_evidence: 2, min_group_size: 3 },
    },
    ...extra,
  };
}

function status(extra: Record<string, unknown> = {}) {
  return {
    classify_enabled: true,
    analytics_enabled: true,
    llm_enabled: false,
    llm_model: "",
    llm_external_allowed: false,
    policy_version: 2,
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
    ...extra,
  };
}

const ref = (id: string, name: string) => ({
  id,
  name,
  level: id.split(".").length,
  parent_id: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "",
  top_id: id.split(".")[0],
  enabled: true,
});

const requestRow = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  request_id: id,
  created_at: "2026-11-26T02:00:00Z",
  session_id: "sess_1",
  team: "platform",
  user: "",
  client: "Claude Code",
  model: "gpt-4.1",
  category: ref("other", "기타 및 미분류"),
  action_type: "unknown",
  confidence: 0.41,
  method: "rule",
  status: "review",
  work_title: title,
  tags: ["배포"],
  technologies: [],
  tokens: 1200,
  cost_krw: 14,
  latency_ms: 900,
  is_error: false,
  policy_version: 2,
  ...extra,
});

function reviewPage(
  rows: unknown[] = [requestRow("req-1", "배포 스크립트 수정"), requestRow("req-2", "릴리스 노트 정리")],
) {
  return {
    rows,
    count: rows.length,
    limit: 50,
    offset: 0,
    summary: {
      review: 12,
      unclassified: 5,
      failed: 1,
      new_category_hints: [{ hint: "릴리스 관리", count: 7 }],
    },
  };
}

function setup(handlers: Record<string, ApiHandler> = {}) {
  return mockApi({
    [`GET ${api}/policy`]: () => policy(),
    [`GET ${api}/status`]: () => status(),
    [`GET ${api}/policy/versions`]: () => ({ versions: [] }),
    ...handlers,
  });
}

/** Shows the router's location so a test can read what the screen wrote to the URL. */
function LocationProbe(): React.JSX.Element {
  const current = useLocation();
  return <output data-testid="location">{`${current.pathname}${current.search}`}</output>;
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent;
}

function renderAt(search = "", readOnly = false) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`${route}${search}`]}>
        <UnsavedChangesProvider>
          <FeatureAccessContext.Provider
            value={{ featureId: "insights.classification", permitted: true, readOnly }}
          >
            <ClassificationPage />
            <LocationProbe />
          </FeatureAccessContext.Provider>
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bodyOf<Body>(gateway: ReturnType<typeof mockApi>, key: string): Body {
  const bodies = gateway.bodies(key);
  expect(bodies.length).toBeGreaterThan(0);
  return bodies.at(-1) as Body;
}

interface SavedBody {
  config: ReturnType<typeof config>;
  expected_revision: number;
  reason: string;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  scopes = ["admin:read", "admin:write"];
});

describe("ClassificationPage draft", () => {
  it("edits a category and saves the draft on top of the loaded revision", async () => {
    const gateway = setup({
      [`PUT ${api}/policy`]: ({ body }) => ({
        config: (body as SavedBody).config,
        revision: 5,
        updated_by: "ops",
        updated_at: "2026-11-26T03:00:00Z",
      }),
    });
    renderAt("?tab=categories&category=dev.codegen");
    const keywords = await screen.findByLabelText(/^키워드/u);
    expect(keywords).toHaveValue("함수, api");
    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toBeDisabled();
    expect(screen.getByText("초안 리비전 4")).toBeVisible();

    fireEvent.change(keywords, { target: { value: "함수, api,\n클래스" } });
    expect(screen.getByText("규칙 변경 1")).toBeVisible();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText("초안 리비전 5")).toBeVisible());
    const body = bodyOf<SavedBody>(gateway, `PUT ${api}/policy`);
    expect(body.expected_revision).toBe(4);
    expect(body.config.categories.find((c) => c.id === "dev.codegen")?.rules.keywords).toEqual([
      "함수",
      "api",
      "클래스",
    ]);
    expect(body.config.categories).toHaveLength(14);
    expect(save).toBeDisabled();
  });

  it("saves with Ctrl+S and puts the draft back with 되돌리기", async () => {
    const gateway = setup({
      [`PUT ${api}/policy`]: ({ body }) => ({ config: (body as SavedBody).config, revision: 5 }),
    });
    renderAt("?tab=categories&category=dev.codegen");
    const name = await screen.findByLabelText(/^이름/u);
    // Nothing to save yet: the shortcut does nothing.
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.change(name, { target: { value: "코드 작성" } });
    expect(screen.getByText("이름 변경 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /되돌리기/u }));
    expect(screen.getByLabelText(/^이름/u)).toHaveValue("코드 생성");
    expect(screen.queryByText("이름 변경 1")).toBeNull();

    fireEvent.change(screen.getByLabelText(/^이름/u), { target: { value: "코드 작성" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(screen.getByText("초안 리비전 5")).toBeVisible());
    expect(gateway.bodies(`PUT ${api}/policy`)).toHaveLength(1);
    expect(
      bodyOf<SavedBody>(gateway, `PUT ${api}/policy`).config.categories.find((c) => c.id === "dev.codegen")
        ?.name,
    ).toBe("코드 작성");
  });

  it("adds a child category with an id made from its name", async () => {
    const gateway = setup({
      [`PUT ${api}/policy`]: ({ body }) => ({ config: (body as SavedBody).config, revision: 5 }),
    });
    renderAt("?tab=categories&category=dev");
    fireEvent.click(await screen.findByRole("button", { name: /하위 카테고리 추가/u }));
    const dialog = screen.getByRole("dialog", { name: "하위 카테고리 추가" });
    fireEvent.change(within(dialog).getByLabelText(/이름/u), { target: { value: "Unit Test 작성" } });
    expect(within(dialog).getByLabelText(/^ID/u)).toHaveValue("dev.unit-test");
    fireEvent.change(within(dialog).getByLabelText(/^ID/u), { target: { value: "dev.Bad Id" } });
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^ID/u), { target: { value: "dev.unittest" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "추가" }));

    expect(await screen.findByRole("heading", { name: "Unit Test 작성" })).toBeVisible();
    expect(currentLocation()).toContain("category=dev.unittest");
    expect(screen.getByText("카테고리 추가 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gateway.bodies(`PUT ${api}/policy`)).toHaveLength(1));
    const saved = bodyOf<SavedBody>(gateway, `PUT ${api}/policy`).config.categories;
    // The child sits right after its parent's existing children.
    expect(saved.map((c) => c.id).slice(12)).toEqual(["dev.codegen", "dev.review", "dev.unittest"]);
    expect(saved.at(-1)).toMatchObject({ parent_id: "dev", name: "Unit Test 작성", enabled: true });
  });

  it("never lets the required top-level categories be removed, nor 'other' be turned off", async () => {
    setup();
    renderAt("?tab=categories&category=other");
    expect(await screen.findByRole("heading", { name: "기타 및 미분류" })).toBeVisible();
    expect(screen.getByRole("button", { name: /삭제/u })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "기타 및 미분류 사용" })).toBeDisabled();
    expect(screen.getByText("'기타 및 미분류'는 다른 카테고리로 병합할 수 없습니다.")).toBeVisible();
  });

  it("merges a category into one of the same level and explains what happens to statistics", async () => {
    setup();
    renderAt("?tab=categories&category=dev.review");
    const target = await screen.findByLabelText("병합 대상");
    expect(
      within(target)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["병합하지 않음", "코드 생성 (dev.codegen)"]);
    fireEvent.change(target, { target: { value: "dev.codegen" } });
    expect(screen.getByText("병합된 카테고리입니다.")).toBeVisible();
    expect(screen.getByText(/과거\s+통계는 원래 ID/u)).toBeVisible();
    expect(screen.getByText("병합 1")).toBeVisible();
  });

  it("filters the tree by keyword", async () => {
    setup();
    renderAt("?tab=categories");
    const tree = await screen.findByRole("navigation", { name: "카테고리 트리" });
    expect(within(tree).getAllByRole("button", { current: false }).length).toBeGreaterThan(10);
    fireEvent.change(screen.getByRole("searchbox", { name: /카테고리 찾기/u }), {
      target: { value: "함수" },
    });
    expect(within(tree).getByText("코드 생성")).toBeVisible();
    expect(within(tree).queryByText("코드 리뷰")).toBeNull();
    expect(within(tree).queryByText("정보보호")).toBeNull();
    expect(screen.getByText("2개 표시")).toBeVisible();
  });

  it("keeps the draft and explains a conflict when someone else saved first", async () => {
    setup({
      [`PUT ${api}/policy`]: () => {
        throw new AppError("conflict", { kind: "http", status: 409, code: "work_policy_conflict" });
      },
    });
    renderAt("?tab=categories&category=dev.codegen");
    fireEvent.change(await screen.findByLabelText(/^이름/u), { target: { value: "코드 작성" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("다른 운영자가 먼저 저장했습니다.")).toBeVisible();
    expect(screen.getByLabelText(/^이름/u)).toHaveValue("코드 작성");
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /최신 설정 불러오기/u })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /최신 설정 불러오기/u }));
    await waitFor(() => expect(screen.getByLabelText(/^이름/u)).toHaveValue("코드 생성"));
    expect(screen.queryByText("다른 운영자가 먼저 저장했습니다.")).toBeNull();
  });

  it("lists server issues by place and opens the category an issue is about", async () => {
    setup({
      [`PUT ${api}/policy`]: () => {
        throw new AppError("invalid", {
          kind: "http",
          status: 422,
          code: "work_policy_invalid",
          details: {
            error: { code: "work_policy_invalid" },
            issues: [
              { path: "categories[13].rules.keywords[0]", message: "키워드는 80바이트 이하여야 합니다." },
              { path: "thresholds.accept", message: "확정 기준은 0과 1 사이여야 합니다." },
            ],
          },
        });
      },
    });
    renderAt("?tab=policy");
    fireEvent.change(await screen.findByLabelText("최소 근거 수"), { target: { value: "3" } });
    expect(screen.getByText("임계값 변경")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("정책 오류 2건 — 저장하지 않았습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "임계값 · 확정 기준" })).toBeVisible();
    expect(within(screen.getByRole("tab", { name: /카테고리/u })).getByText("1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "카테고리 코드 리뷰 · 키워드 1번째" }));

    expect(await screen.findByRole("heading", { name: "코드 리뷰" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /카테고리/u })).toHaveAttribute("aria-selected", "true");
    expect(currentLocation()).toContain("category=dev.review");
    // The same message sits on the field it is about.
    expect(screen.getByText("키워드는 80바이트 이하여야 합니다.")).toBeVisible();
    expect(screen.getByLabelText(/^키워드/u)).toHaveAttribute("aria-invalid", "true");
    // The unsaved threshold edit is still there.
    expect(screen.getByText("임계값 변경")).toBeVisible();
  });

  it("shows a local problem without calling the server", async () => {
    const gateway = setup();
    renderAt("?tab=policy");
    fireEvent.change(await screen.findByLabelText("확정 기준"), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("정책 오류 1건 — 저장하지 않았습니다.")).toBeVisible();
    expect(
      screen.getAllByText("확정 기준(0.3)은 검토 기준(0.5)보다 낮을 수 없습니다.").length,
    ).toBeGreaterThan(0);
    expect(gateway.bodies(`PUT ${api}/policy`)).toHaveLength(0);
  });

  it("edits baselines in the shared draft", async () => {
    const gateway = setup({
      [`PUT ${api}/policy`]: ({ body }) => ({ config: (body as SavedBody).config, revision: 5 }),
    });
    renderAt("?tab=baselines");
    expect(await screen.findByText("아직 기준값이 없습니다.")).toBeVisible();
    expect(screen.getByText(/완료가 확인된 세션/u)).toBeVisible();
    fireEvent.change(screen.getByLabelText("기준값을 추가할 카테고리"), { target: { value: "dev.codegen" } });
    fireEvent.click(screen.getByRole("button", { name: /기준값 추가/u }));
    fireEvent.change(screen.getByLabelText("수동 처리 시간(분)"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("AI 활용 처리 시간(분)"), { target: { value: "0" } });
    expect(screen.getByText("AI 활용 처리 시간(분)은 0보다 커야 합니다.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("AI 활용 처리 시간(분)"), { target: { value: "30" } });
    expect(screen.getByText(/추정 절감: 60분 · ₩50,000/u)).toBeVisible();
    expect(screen.getByText("기준값 변경 1")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gateway.bodies(`PUT ${api}/policy`)).toHaveLength(1));
    expect(bodyOf<SavedBody>(gateway, `PUT ${api}/policy`).config.baselines).toEqual([
      { category_id: "dev.codegen", manual_minutes: 90, ai_minutes: 30, hourly_cost_krw: 50000, note: "" },
    ]);
  });
});

describe("ClassificationPage policy and versions", () => {
  const versions = {
    versions: [
      {
        version: 2,
        note: "코드 리뷰 분리",
        published_by: "ops",
        published_at: "2026-11-25T01:00:00Z",
        categories: 13,
        changes: { added: ["dev.codegen"], removed: [], renamed: ["infra"], merged: [], rules_changed: [] },
      },
      {
        version: 1,
        note: "첫 배포",
        published_by: "ops",
        published_at: "2026-11-20T01:00:00Z",
        categories: 12,
        changes: { added: [], removed: [], renamed: [], merged: [], rules_changed: [] },
      },
    ],
  };
  const publishedConfig = () => {
    const current = config();
    return {
      ...current,
      categories: current.categories.filter((c) => c.id !== "dev.review"),
      thresholds: { ...current.thresholds, accept: 0.8 },
      llm: { system_prompt: "예전 프롬프트", max_input_chars: 1200 },
    };
  };

  it("publishes the saved draft after showing what changes, then shows the impact", async () => {
    const gateway = setup({
      [`GET ${api}/policy`]: () => policy({ dirty: true }),
      [`GET ${api}/policy/versions`]: () => versions,
      [`GET ${api}/policy/versions/2`]: () => ({
        version: 2,
        config: publishedConfig(),
        note: "코드 리뷰 분리",
        published_by: "ops",
        published_at: "2026-11-25T01:00:00Z",
      }),
      [`POST ${api}/policy/publish`]: () => ({
        version: 3,
        published_at: "2026-11-26T03:00:00Z",
        impact: { categories_removed: 1, affected_requests: 132 },
      }),
    });
    renderAt("?tab=policy");
    expect(await screen.findByText("초안이 배포본과 다름")).toBeVisible();
    expect(screen.getByText(/초안을 저장해도 분류는 바뀌지 않습니다/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "배포" }));

    const dialog = screen.getByRole("dialog", { name: "정책 배포" });
    expect(
      await within(dialog).findByText(/버전 2 대비 변경: 카테고리 추가 1 · 임계값 변경 · LLM 설정 변경/u),
    ).toBeVisible();
    expect(within(dialog).getByText("추가: 코드 리뷰 (dev.review)")).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "배포" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), {
      target: { value: "코드 리뷰 카테고리 추가" },
    });
    fireEvent.click(confirm);

    expect(await screen.findByText("정책 버전 3 배포를 마쳤습니다.")).toBeVisible();
    expect(screen.getByText(/삭제된 카테고리 1개 · 영향받는 요청\s+132건/u)).toBeVisible();
    expect(bodyOf(gateway, `POST ${api}/policy/publish`)).toEqual({
      expected_revision: 4,
      note: "코드 리뷰 카테고리 추가",
    });
  });

  it("does not publish while the screen has unsaved changes", async () => {
    setup({ [`GET ${api}/policy`]: () => policy({ dirty: true }) });
    renderAt("?tab=policy");
    fireEvent.change(await screen.findByLabelText("최소 근거 수"), { target: { value: "3" } });
    const publish = screen.getByRole("button", { name: "배포" });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute("title", "저장하지 않은 변경이 있습니다. 먼저 초안을 저장하세요.");
  });

  it("lists versions with their changes and rolls back to one with a note", async () => {
    const gateway = setup({
      [`GET ${api}/policy/versions`]: () => versions,
      [`POST ${api}/policy/rollback`]: () => ({ version: 3, published_at: "2026-11-26T03:00:00Z" }),
    });
    renderAt("?tab=policy");
    const list = await screen.findByRole("list", { name: "배포 버전 목록" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("현재 배포본")).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText("추가 1")).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText("이름 변경 1")).toBeVisible();
    // The published version equals the draft: nothing to roll back to.
    expect(screen.getByRole("button", { name: /이 버전으로 롤백 \(버전 2\)/u })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /이 버전으로 롤백 \(버전 1\)/u }));
    const dialog = screen.getByRole("dialog", { name: "버전 1 롤백" });
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), { target: { value: "오분류 증가" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "롤백" }));
    await waitFor(() => expect(gateway.bodies(`POST ${api}/policy/rollback`)).toHaveLength(1));
    expect(bodyOf(gateway, `POST ${api}/policy/rollback`)).toEqual({ version: 1, note: "오분류 증가" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("compares a version with the current draft side by side", async () => {
    setup({
      [`GET ${api}/policy/versions`]: () => versions,
      [`GET ${api}/policy/versions/2`]: () => ({
        version: 2,
        config: publishedConfig(),
        note: "코드 리뷰 분리",
        published_by: "ops",
        published_at: "2026-11-25T01:00:00Z",
      }),
    });
    renderAt("?tab=policy");
    fireEvent.click(await screen.findByRole("button", { name: /내용 보기 \(버전 2\)/u }));
    const sheet = await screen.findByRole("dialog", { name: "정책 버전 2" });
    expect(currentLocation()).toContain("version=2");
    const table = await within(sheet).findByRole("table", { name: "버전 2 · 현재 초안 임계값 비교" });
    const accept = within(table).getByRole("row", { name: /확정 기준/u });
    expect(within(accept).getByText("0.8")).toBeVisible();
    expect(within(accept).getByText("0.72")).toBeVisible();
    expect(within(accept).getByText("다름")).toBeVisible();
    expect(within(sheet).getByLabelText("버전 2의 시스템 프롬프트")).toHaveTextContent("예전 프롬프트");
    expect(within(sheet).getByLabelText("현재 초안의 시스템 프롬프트")).toHaveTextContent(
      "요청을 업무 카테고리로 분류하세요.",
    );
    expect(within(sheet).getByText("추가: 코드 리뷰 (dev.review)")).toBeVisible();
  });
});

describe("ClassificationPage test tab", () => {
  it("classifies a sample with the saved draft and shows the candidates", async () => {
    const gateway = setup({
      [`POST ${api}/policy/test`]: () => ({
        result: {
          category: ref("dev.codegen", "코드 생성"),
          action_type: "create",
          confidence: 0.84,
          method: "rule",
          status: "classified",
          tags: ["rest"],
          technologies: ["go"],
          work_title: "주문 조회 API 작성",
          category_id: "",
          target_system: "",
          new_category_hint: "",
        },
        candidates: [
          { category: ref("dev.codegen", "코드 생성"), score: 3.2, evidence: ["키워드: api", "언어: go"] },
          { category: ref("dev.review", "코드 리뷰"), score: 0.6, evidence: ["키워드: 코드"] },
        ],
        llm: { used: false, error: "" },
      }),
    });
    renderAt("?tab=test");
    const llm = await screen.findByRole("switch", { name: "LLM 사용" });
    expect(llm).toBeDisabled();
    expect(screen.getByText(/LLM 분류가 꺼져 있어 규칙과 캐시만으로 검사합니다/u)).toBeVisible();
    expect(screen.getByRole("switch", { name: "초안으로 검사" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "API 코드 작성" }));
    expect((screen.getByLabelText(/분류할 텍스트/u) as HTMLTextAreaElement).value).toContain("REST API");
    fireEvent.click(screen.getByRole("button", { name: "분류" }));

    const result = await screen.findByRole("region", { name: "분류 결과" });
    expect(within(result).getByText("소프트웨어 개발 › 코드 생성", { selector: "strong" })).toBeVisible();
    expect(within(result).getByText("0.84")).toBeVisible();
    expect(within(result).getByText("분류됨")).toBeVisible();
    expect(within(result).getByText("주문 조회 API 작성")).toBeVisible();
    const candidates = within(result).getByRole("table", { name: "후보 카테고리" });
    expect(within(candidates).getAllByRole("row")).toHaveLength(3);
    expect(within(candidates).getByText("언어: go")).toBeVisible();

    expect(bodyOf(gateway, `POST ${api}/policy/test`)).toEqual({
      text: expect.stringContaining("REST API") as string,
      task_type: "generate",
      languages: ["go"],
      client: "Claude Code",
      use_draft: true,
      use_llm: false,
    });
  });

  it("asks the model only when LLM classification is on, and reports missing corrections", async () => {
    const gateway = setup({
      [`GET ${api}/status`]: () => status({ llm_enabled: true, llm_model: "classifier-small" }),
      [`POST ${api}/policy/test`]: () => ({
        result: {
          category: null,
          category_id: "other",
          action_type: "unknown",
          confidence: 0.2,
          method: "llm",
          status: "review",
          tags: [],
          technologies: [],
          work_title: "",
          target_system: "",
          new_category_hint: "생활 정보",
        },
        candidates: [],
        llm: { used: true, error: "" },
      }),
      [`POST ${api}/policy/evaluate`]: () => ({
        sample: 4,
        accuracy: null,
        top_accuracy: null,
        by_category: [],
        confusions: [],
        note: "보정 이력이 30건 이상 쌓이면 정확도를 계산합니다.",
      }),
    });
    renderAt("?tab=test");
    const llm = await screen.findByRole("switch", { name: "LLM 사용" });
    await waitFor(() => expect(llm).toBeEnabled());
    fireEvent.click(llm);
    fireEvent.click(screen.getByRole("switch", { name: "초안으로 검사" }));
    fireEvent.change(screen.getByLabelText(/분류할 텍스트/u), { target: { value: "점심 메뉴 추천" } });
    fireEvent.click(screen.getByRole("button", { name: "분류" }));
    expect(await screen.findByText("분류 모델에 물어 얻은 결과입니다.")).toBeVisible();
    expect(screen.getByText("기타 및 미분류", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("생활 정보")).toBeVisible();
    expect(screen.getByText("근거가 맞은 카테고리가 없습니다.")).toBeVisible();
    expect(bodyOf(gateway, `POST ${api}/policy/test`)).toEqual({
      text: "점심 메뉴 추천",
      use_draft: false,
      use_llm: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /정확도 확인/u }));
    expect(await screen.findByText("아직 정확도를 계산할 수 없습니다.")).toBeVisible();
    expect(screen.getByText(/보정 이력이 30건 이상 쌓이면 정확도를 계산합니다/u)).toBeVisible();
    expect(bodyOf(gateway, `POST ${api}/policy/evaluate`)).toEqual({ use_draft: true, limit: 500 });
  });

  it("shows accuracy per category and the most common confusions", async () => {
    setup({
      [`POST ${api}/policy/evaluate`]: () => ({
        sample: 120,
        accuracy: 0.825,
        top_accuracy: 0.9,
        by_category: [{ category: ref("dev.codegen", "코드 생성"), total: 40, correct: 36 }],
        confusions: [{ expected: "dev.review", got: "dev.codegen", count: 6 }],
        note: "",
      }),
    });
    renderAt("?tab=test");
    fireEvent.click(await screen.findByRole("button", { name: /정확도 확인/u }));
    const result = await screen.findByRole("region", { name: "정확도 확인 결과" });
    expect(within(result).getByText("82.5%")).toBeVisible();
    expect(within(result).getByText("120건")).toBeVisible();
    const byCategory = within(result).getByRole("table", { name: "카테고리별 정확도" });
    expect(within(byCategory).getByRole("row", { name: /코드 생성/u })).toHaveTextContent("90.0%");
    const confusions = within(result).getByRole("table", { name: "자주 헷갈린 분류" });
    expect(within(confusions).getByRole("row", { name: /코드 리뷰/u })).toHaveTextContent("코드 생성");
  });
});

describe("ClassificationPage review", () => {
  it("reads the filters from the URL and pages on the server", async () => {
    const queries: unknown[] = [];
    setup({
      [`GET ${api}/review`]: ({ query }) => {
        queries.push(query);
        return { ...reviewPage(), count: 120 };
      },
    });
    renderAt("?tab=review&status=unclassified&category=dev&max_conf=0.5&page=2");
    expect(await screen.findByText("배포 스크립트 수정")).toBeVisible();
    expect(queries[0]).toEqual({
      status: "unclassified",
      category: "dev",
      max_conf: 0.5,
      limit: 50,
      offset: 50,
    });
    expect(screen.getByLabelText("상태")).toHaveValue("unclassified");
    expect(screen.getByLabelText("신뢰도 상한")).toHaveValue("0.5");
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(screen.getByText("릴리스 관리")).toBeVisible();

    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "failed" } });
    await waitFor(() =>
      expect(queries.at(-1)).toEqual({
        status: "failed",
        category: "dev",
        max_conf: 0.5,
        limit: 50,
        offset: 0,
      }),
    );
    expect(currentLocation()).toContain("status=failed");
    expect(currentLocation()).not.toContain("page=");
  });

  it("shows the category in place of a work title the caller may not see, without empty tags", async () => {
    setup({
      [`GET ${api}/review`]: () => ({
        ...reviewPage([
          requestRow("req-9", "", { tags: [], technologies: [], category: ref("dev.review", "코드 리뷰") }),
        ]),
        summary: { review: 1, unclassified: 0, failed: 0, new_category_hints: [] },
      }),
    });
    renderAt("?tab=review");
    const fallback = await screen.findByTitle("작업 제목이 없어 업무 이름을 대신 표시합니다.");
    expect(fallback).toHaveTextContent(/^코드 리뷰$/u);
    expect(screen.queryByText("(제목 없음)")).toBeNull();
    expect(fallback.closest(".wc-title-cell")?.querySelector(".wc-chips")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "req-9 선택" })).toBeVisible();
    expect(screen.getByText("후보가 없습니다.")).toBeVisible();
  });

  it("corrects the selected requests in one call and reports the rebuilt days", async () => {
    const gateway = setup({
      [`GET ${api}/review`]: () => reviewPage(),
      [`POST ${api}/review/correct`]: () => ({ corrected: 2, days_rebuilt: ["2026-11-26"] }),
    });
    renderAt("?tab=review");
    const correct = await screen.findByRole("button", { name: /분류 보정/u });
    expect(correct).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: "배포 스크립트 수정 선택" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "릴리스 노트 정리 선택" }));
    expect(screen.getByText(/이 페이지 2건 중 2건 선택/u)).toBeVisible();
    fireEvent.click(correct);

    const dialog = screen.getByRole("dialog", { name: "분류 보정" });
    expect(within(dialog).getByText(/검증 데이터로 쌓여/u)).toBeVisible();
    const submit = within(dialog).getByRole("button", { name: "2건 보정" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("카테고리 찾기"), { target: { value: "리뷰" } });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("radio", { name: /소프트웨어 개발 › 코드 리뷰/u }));
    fireEvent.change(within(dialog).getByLabelText("작업 유형"), { target: { value: "analyze" } });
    fireEvent.change(within(dialog).getByLabelText(/보정 사유/u), { target: { value: "리뷰 요청임" } });
    fireEvent.click(submit);

    expect(await screen.findByText("2건의 분류를 보정했습니다.")).toBeVisible();
    expect(screen.getByText("집계를 다시 만든 날짜: 2026-11-26")).toBeVisible();
    expect(bodyOf(gateway, `POST ${api}/review/correct`)).toEqual({
      request_ids: ["req-1", "req-2"],
      category_id: "dev.review",
      action_type: "analyze",
      reason: "리뷰 요청임",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/이 페이지 2건 중 0건 선택/u)).toBeVisible();
  });
});

describe("ClassificationPage reclassify", () => {
  const preview = {
    revision: "rev-abc",
    reviewed_at: "2026-11-26T03:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    total: 200,
    by_status: { review: 150, unclassified: 50 },
    by_method: { rule: 180, llm: 20 },
    manual_kept: 12,
    est_llm_calls: 40,
    days: 7,
    active_job: null,
  };
  const job = (state: string, done: number) => ({
    id: "job-1",
    status: state,
    actor: "ops",
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

  it("previews the impact, starts the reviewed run and polls until the job has finished", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const gateway = setup({
      [`GET ${api}/reclassify`]: () => preview,
      [`POST ${api}/reclassify`]: () => job("queued", 0),
      [`GET ${api}/reclassify/jobs/job-1`]: () => {
        polls += 1;
        return polls === 1 ? job("running", 50) : job("succeeded", 200);
      },
    });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26&status=review");
    const run = await screen.findByRole("button", { name: /재분류 실행/u });
    expect(run).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /영향 미리보기/u }));

    const impact = await screen.findByRole("region", { name: "재분류 영향 미리보기" });
    expect(within(impact).getByText("200건")).toBeVisible();
    expect(within(impact).getByText("12건")).toBeVisible();
    expect(within(impact).getByText("40회")).toBeVisible();
    expect(within(impact).getByText("150건")).toBeVisible();
    expect(within(impact).queryByText("텍스트 없어 유지")).toBeNull();
    expect(gateway.calls.find((call) => call.key === `GET ${api}/reclassify`)?.options.query).toEqual({
      from: "2026-11-20",
      to: "2026-11-26",
      status: "review",
    });

    fireEvent.click(run);
    const dialog = screen.getByRole("dialog", { name: "재분류 실행" });
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), { target: { value: "정책 버전 3 적용" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "재분류 시작" }));

    const progress = await screen.findByRole("progressbar", { name: "재분류 진행률" });
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "25"));
    const started = gateway.calls.find((call) => call.key === `POST ${api}/reclassify`);
    expect(started?.options).toEqual({
      query: { reviewed: "1" },
      body: { revision: "rev-abc", reviewed_at: "2026-11-26T03:00:00Z", reason: "정책 버전 3 적용" },
    });
    expect(currentLocation()).toContain("job=job-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(await screen.findByText("재분류를 마쳤습니다.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "재분류 진행률" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    // A server that does not report the previewed count says nothing about drift.
    expect(screen.queryByText(/미리보기 이후 대상이/u)).toBeNull();
    expect(polls).toBe(2);

    // A finished job is not asked about again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(polls).toBe(2);
  });

  it("says how far the target moved since the preview, which no longer stops the run", async () => {
    const moved = job("running", 100);
    setup({
      [`GET ${api}/reclassify/jobs/job-1`]: () => ({
        ...moved,
        progress: { ...moved.progress, total: 230, previewed: 200 },
      }),
    });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26&job=job-1");
    expect(await screen.findByText("미리보기 이후 대상이 200건 → 230건으로 바뀌었습니다.")).toBeVisible();
    expect(screen.getByText(/100 \/ 230건 처리/u)).toBeVisible();
  });

  it("says nothing about drift when the previewed count still holds", async () => {
    const same = job("running", 100);
    setup({
      [`GET ${api}/reclassify/jobs/job-1`]: () => ({
        ...same,
        progress: { ...same.progress, previewed: 200 },
      }),
    });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26&job=job-1");
    expect(await screen.findByText(/100 \/ 200건 처리/u)).toBeVisible();
    expect(screen.queryByText(/미리보기 이후 대상이/u)).toBeNull();
  });

  it("says how many requests keep their category because their prompt text is gone", async () => {
    setup({ [`GET ${api}/reclassify`]: () => ({ ...preview, no_text_kept: 30 }) });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26");
    fireEvent.click(await screen.findByRole("button", { name: /영향 미리보기/u }));
    const impact = await screen.findByRole("region", { name: "재분류 영향 미리보기" });
    expect(within(impact).getByText("텍스트 없어 유지")).toBeVisible();
    expect(within(impact).getByText("30건")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /재분류 실행/u }));
    const dialog = screen.getByRole("dialog", { name: "재분류 실행" });
    expect(within(dialog).getByText(/텍스트가 없는 요청 30건은 기존 분류를/u)).toBeVisible();
  });

  it("reads a bounded text lookup as a lower bound", async () => {
    setup({ [`GET ${api}/reclassify`]: () => ({ ...preview, no_text_kept: 50000, no_text_capped: true }) });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26");
    fireEvent.click(await screen.findByRole("button", { name: /영향 미리보기/u }));
    const impact = await screen.findByRole("region", { name: "재분류 영향 미리보기" });
    expect(within(impact).getByText("50,000건 이상")).toBeVisible();
  });

  it("asks for a new preview when the reviewed one expired or no longer matches", async () => {
    setup({
      [`GET ${api}/reclassify`]: () => preview,
      [`POST ${api}/reclassify`]: () => {
        throw new AppError("expired", { kind: "http", status: 409, code: "work_reclassify_expired" });
      },
    });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26");
    fireEvent.click(await screen.findByRole("button", { name: /영향 미리보기/u }));
    await screen.findByRole("region", { name: "재분류 영향 미리보기" });
    fireEvent.click(screen.getByRole("button", { name: /재분류 실행/u }));
    const dialog = screen.getByRole("dialog", { name: "재분류 실행" });
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), { target: { value: "다시" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "재분류 시작" }));

    expect(await screen.findByText("미리보기를 다시 실행하세요.")).toBeVisible();
    expect(screen.getAllByText(/미리보기가 만료되었습니다/u).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("region", { name: "재분류 영향 미리보기" })).toBeNull();
    expect(screen.getByRole("button", { name: /재분류 실행/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다시 미리보기" })).toBeVisible();
  });

  it("shows the running job when another reclassification is already active", async () => {
    setup({
      [`GET ${api}/reclassify`]: () => preview,
      [`POST ${api}/reclassify`]: () => {
        throw new AppError("active", {
          kind: "http",
          status: 409,
          code: "work_job_active",
          details: { error: { code: "work_job_active" }, active_job: { ...job("running", 50), id: "job-9" } },
        });
      },
      [`GET ${api}/reclassify/jobs/job-9`]: () => ({ ...job("succeeded", 200), id: "job-9" }),
    });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26");
    fireEvent.click(await screen.findByRole("button", { name: /영향 미리보기/u }));
    await screen.findByRole("region", { name: "재분류 영향 미리보기" });
    fireEvent.click(screen.getByRole("button", { name: /재분류 실행/u }));
    const dialog = screen.getByRole("dialog", { name: "재분류 실행" });
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), { target: { value: "다시" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "재분류 시작" }));

    expect(await screen.findByText("재분류를 시작하지 않았습니다.")).toBeVisible();
    expect(await screen.findByText("job-9")).toBeVisible();
    expect(currentLocation()).toContain("job=job-9");
  });

  it("rebuilds aggregates for a period as a separate repair", async () => {
    const gateway = setup({ [`POST ${api}/rebuild`]: () => ({ days_rebuilt: 7 }) });
    renderAt("?tab=reclassify&from=2026-11-20&to=2026-11-26");
    expect(
      await screen.findByText(/통계 숫자가 요청 목록과 맞지 않을 때 쓰는 복구 작업입니다/u),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /집계 다시 만들기/u }));
    const dialog = screen.getByRole("dialog", { name: "집계 다시 만들기" });
    fireEvent.change(within(dialog).getByLabelText(/변경 사유/u), { target: { value: "집계 불일치" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 만들기" }));
    expect(await screen.findByText("2026-11-20 ~ 2026-11-26 집계를 다시 만들었습니다.")).toBeVisible();
    expect(bodyOf(gateway, `POST ${api}/rebuild`)).toEqual({
      from: "2026-11-20",
      to: "2026-11-26",
      reason: "집계 불일치",
    });
  });
});

describe("ClassificationPage states", () => {
  it("shows the worker status and links to the WORK_INTEL settings", async () => {
    setup({ [`GET ${api}/status`]: () => status({ last_error: "llm timeout" }) });
    renderAt();
    expect(await screen.findByText("37건")).toBeVisible();
    expect(screen.getByText("1분 35초")).toBeVisible();
    expect(screen.getByText("4,200건")).toBeVisible();
    expect(screen.getByText(/요청 경로에서는 실행되지 않으므로/u)).toBeVisible();
    expect(screen.getByText("llm timeout")).toBeVisible();
    const methods = screen.getByRole("list", { name: "방식별 분류 건수" });
    expect(within(methods).getByText(/3,000건 · 71\.4%/u)).toBeVisible();
    expect(screen.getByRole("link", { name: /시스템 설정에서 WORK_INTEL_\* 열기/u })).toHaveAttribute(
      "href",
      "/system/settings?tab=runtime&q=WORK_INTEL",
    );
  });

  it("is read-only without admin:write and says why", async () => {
    scopes = ["admin:read"];
    setup({
      [`GET ${api}/policy`]: () => policy({ dirty: true }),
      [`GET ${api}/review`]: () => reviewPage(),
    });
    const view = renderAt("?tab=categories&category=dev.codegen");
    expect(await screen.findByLabelText(/^이름/u)).toBeDisabled();
    expect(screen.getByText("읽기 전용입니다.")).toBeVisible();
    expect(screen.getByText(/분류 정책을 바꾸려면 admin:write 권한이 필요합니다/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    const addChild = screen.getByRole("button", { name: /하위 카테고리 추가/u });
    expect(addChild).toBeDisabled();
    expect(addChild).toHaveAttribute("title", "분류 정책을 바꾸려면 admin:write 권한이 필요합니다.");
    expect(screen.getByLabelText(/^키워드/u)).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "정책·버전" }));
    expect(await screen.findByRole("button", { name: "배포" })).toBeDisabled();
    expect(screen.getByLabelText("확정 기준")).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "검토" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "배포 스크립트 수정 선택" }));
    expect(screen.getByRole("button", { name: /분류 보정/u })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "테스트" }));
    expect(await screen.findByRole("button", { name: "분류" })).toBeDisabled();
    view.unmount();
  });

  it("is read-only when the screen itself is rolled out read-only", async () => {
    setup();
    renderAt("?tab=categories&category=dev.codegen", true);
    expect(await screen.findByLabelText(/^이름/u)).toBeDisabled();
    expect(screen.getByText(/이 화면은 읽기 전용입니다/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
  });

  it("says so when the gateway does not have the API yet", async () => {
    const missing = () => {
      throw new AppError("not implemented", {
        kind: "http",
        status: 501,
        code: "work_intel_not_implemented",
        retryable: true,
      });
    };
    const gateway = setup({ [`GET ${api}/policy`]: missing, [`GET ${api}/status`]: missing });
    renderAt("?tab=categories");
    expect(await screen.findByText("이 게이트웨이에는 업무 분류 기능이 아직 없습니다.")).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    // A missing API is a state, not a failure to retry.
    expect(gateway.calls.filter((call) => call.key === `GET ${api}/policy`)).toHaveLength(1);
  });

  it("separates a switched-off feature and a failed read from an empty screen", async () => {
    setup({
      [`GET ${api}/policy`]: () => {
        throw new AppError("disabled", { kind: "http", status: 503, code: "work_intel_disabled" });
      },
      [`GET ${api}/status`]: () => {
        throw new AppError("boom", { kind: "http", status: 500 });
      },
    });
    renderAt("?tab=categories");
    expect(await screen.findByText("업무 분류 기능이 꺼져 있습니다.")).toBeVisible();
    expect(screen.getByRole("link", { name: /시스템 설정 열기/u })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "상태" }));
    expect(await screen.findByText("분류 상태 정보를 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
  });

  it("drops another tab's filters when the tab changes", async () => {
    setup({ [`GET ${api}/review`]: () => reviewPage() });
    renderAt("?tab=review&status=failed&category=dev&max_conf=0.5&page=2");
    await screen.findByText("배포 스크립트 수정");
    fireEvent.click(screen.getByRole("tab", { name: "카테고리" }));
    expect(await screen.findByRole("navigation", { name: "카테고리 트리" })).toBeVisible();
    expect(currentLocation()).toBe(`${route}?tab=categories`);
  });
});
