import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLibraryPage } from "@/features/prompts/library/PromptLibraryPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const promptSearchResponse = {
  requests: [
    {
      id: "req_9f1c2d3e4a5b",
      created_at: "2026-09-06T02:11:00Z",
      api_key_id: "key_abcdef123456",
      client_ip: "10.0.0.8",
      model: "gpt-4.1",
      provider: "openai",
      endpoint: "/v1/chat/completions",
      status_code: 200,
      latency_ms: 1820,
      total_tokens: 3400,
      estimated_cost: 412.5,
      session_id: "sess_1",
      prompt_name: "refactor-basic",
      languages: [{ language: "java", lines: 40 }],
      prompts: [{ role: "user", redacted_text: "이 자바 코드를 리팩터링해줘", language_hint: "java" }],
    },
  ],
};

const fingerprintResponse = {
  fingerprints: [
    {
      fingerprint: "fp_1",
      task_type: "refactor",
      requests: 42,
      avg_cost_krw: 310.2,
      total_cost_krw: 13028.4,
      avg_tokens: 2900,
      success_rate: 0.93,
      distinct_models: 2,
      top_model: "gpt-4.1",
      cheapest_model: "gpt-4.1-mini",
      sample_prompt: "이 코드를 리팩터링해줘",
      last_seen: "2026-09-06T01:00:00Z",
    },
  ],
};

const savedFiltersResponse = {
  filters: [
    {
      id: "filt_1",
      name: "보안 리뷰 프롬프트",
      view: "prompts",
      params: "q=security&limit=100",
      created_by: "operator@example.com",
      created_at: "2026-09-01T00:00:00Z",
    },
  ],
};

const assetsResponse = {
  assets: [
    {
      id: "refactor-basic",
      name: "기본 리팩터링",
      category: "refactor",
      description: "레거시 자바 코드를 정리하는 표준 프롬프트",
      body: "다음 코드를 읽고 가독성을 높여 리팩터링하세요.",
      enabled: true,
      use_count: 31,
      last_used_at: "2026-09-05T04:00:00Z",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      tags: ["java", "refactor"],
      status: "standard",
      approved_by: "lead@example.com",
      approved_at: "2026-07-01T00:00:00Z",
      note: "",
      success_rate: 0.96,
      avg_cost_krw: 280.4,
      avg_latency_ms: 1500,
      call_count: 210,
    },
    {
      id: "security-review",
      name: "보안 점검",
      category: "security",
      description: "보안 관점 코드 리뷰 프롬프트",
      body: "다음 코드를 보안 관점에서 점검하세요.",
      enabled: true,
      use_count: 4,
      last_used_at: "",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-20T00:00:00Z",
      tags: ["security"],
      status: "draft",
      approved_by: "",
      approved_at: "",
      note: "",
    },
    {
      id: "test-gen",
      name: "테스트 생성",
      category: "test",
      description: "단위 테스트 생성 프롬프트",
      body: "다음 코드의 단위 테스트를 작성하세요.",
      enabled: true,
      use_count: 12,
      last_used_at: "2026-09-01T00:00:00Z",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
      tags: ["test"],
      status: "pending",
      approved_by: "",
      approved_at: "",
      note: "",
    },
  ],
  stats: { draft: 2, pending: 1, approved: 3, standard: 1 },
  categories: [
    { key: "refactor", label: "리팩터링" },
    { key: "custom", label: "기타" },
  ],
  known_tags: [
    { key: "java", label: "Java" },
    { key: "security", label: "보안" },
  ],
};

const debtResponse = {
  since: "2026-08-08T00:00:00Z",
  count: 1,
  total_debt_cost_krw: 91200.5,
  note: "반복 프롬프트 클러스터를 부채화한 목록입니다.",
  items: [
    {
      fingerprint: "fp_debt_1",
      task_type: "review",
      requests: 88,
      success_rate: 61.2,
      avg_cost_krw: 720.1,
      total_cost_krw: 63368.8,
      top_model: "gpt-4.1",
      cheaper_model: "gpt-4.1-mini",
      debt_score: 74.5,
      debt_type: "failing",
      action: "실패 원인을 조사하고 프롬프트/모델을 교정하세요.",
      sample_prompt: "이 PR을 리뷰해줘",
      last_seen: "2026-09-06T00:00:00Z",
    },
  ],
};

const assetHistoryResponse = {
  history: [
    {
      id: "pth_2",
      template_id: "refactor-basic",
      action: "edit",
      version_num: 2,
      name: "기본 리팩터링",
      category: "refactor",
      description: "",
      body: "다음 코드를 읽고 가독성을 높여 리팩터링하세요.",
      tags: ["java", "refactor"],
      to_status: "standard",
      note: "",
      actor: "lead@example.com",
      has_snapshot: true,
      created_at: "2026-09-01T00:00:00Z",
    },
    {
      id: "pth_1",
      template_id: "refactor-basic",
      action: "create",
      version_num: 1,
      name: "기본 리팩터링",
      category: "refactor",
      description: "",
      body: "코드를 리팩터링하세요.",
      tags: ["java"],
      to_status: "draft",
      note: "",
      actor: "operator@example.com",
      has_snapshot: true,
      created_at: "2026-06-01T00:00:00Z",
    },
    {
      id: "pth_0",
      template_id: "refactor-basic",
      action: "approve",
      version_num: 2,
      from_status: "pending",
      to_status: "approved",
      note: "품질 확인 완료",
      actor: "lead@example.com",
      has_snapshot: false,
      created_at: "2026-07-01T00:00:00Z",
    },
  ],
};

const assetUsageResponse = {
  usage: [
    { team: "platform", calls: 120, errors: 3, cost_krw: 33600.5 },
    { team: "unassigned", calls: 18, errors: 0, cost_krw: 4100 },
  ],
};

function mockAllEndpoints(overrides: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /admin/prompts": () => promptSearchResponse,
    "GET /admin/prompts/fingerprints": () => fingerprintResponse,
    "GET /admin/prompts/debt": () => debtResponse,
    "GET /admin/saved-filters": () => savedFiltersResponse,
    "GET /admin/prompt-assets": () => assetsResponse,
    "POST /admin/templates": () => ({ template: assetsResponse.assets[0] }),
    "DELETE /admin/templates/refactor-basic": () => ({ id: "refactor-basic", status: "deleted" }),
    "PATCH /admin/templates/refactor-basic": () => ({ template: assetsResponse.assets[0] }),
    "GET /admin/templates/refactor-basic/history": () => assetHistoryResponse,
    "GET /admin/templates/refactor-basic/usage": () => assetUsageResponse,
    "POST /admin/templates/refactor-basic/rollback": () => ({
      template: assetsResponse.assets[0],
      restored_from: 1,
    }),
    "POST /admin/templates/refactor-basic/use": () => ({
      id: "refactor-basic",
      name: "기본 리팩터링",
      category: "refactor",
      description: "",
      body: "다음 코드를 읽고 가독성을 높여 리팩터링하세요.",
      tags: ["java", "refactor"],
      status: "standard",
    }),
    "POST /admin/templates/security-review/submit": () => ({ id: "security-review", status: "pending" }),
    "POST /admin/templates/test-gen/approve": () => ({ id: "test-gen", status: "approved" }),
    "POST /admin/saved-filters": () => ({ filter: savedFiltersResponse.filters[0] }),
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/prompts/library") {
  return renderScreen(<PromptLibraryPage />, { route, path: "/prompts/library" });
}

describe("PromptLibraryPage", () => {
  it("프롬프트 검색 결과와 지문 클러스터를 표시한다", async () => {
    mockAllEndpoints();
    render();

    expect(await screen.findByText("이 자바 코드를 리팩터링해줘")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "프롬프트 검색 결과" });
    const row = within(table).getByRole("row", { name: /gpt-4\.1/u });
    expect(within(row).getByText("이 자바 코드를 리팩터링해줘")).toBeInTheDocument();
    expect(within(row).getByText("200")).toBeInTheDocument();

    const fingerprintTable = screen.getByRole("table", { name: "프롬프트 지문 클러스터" });
    expect(within(fingerprintTable).getByText("refactor")).toBeInTheDocument();
    expect(within(fingerprintTable).getByText("gpt-4.1-mini")).toBeInTheDocument();
  });

  it("검색 결과가 없으면 빈 상태를 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/prompts": () => ({ requests: [] }) });
    render();

    expect(await screen.findByText("조건에 맞는 프롬프트가 없습니다.")).toBeInTheDocument();
  });

  it("검색에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/prompts": () => {
        throw apiFailure("prompt search failed", 500, "req_prompts");
      },
    });
    render();

    const notice = (await screen.findByText("프롬프트 검색 결과을(를) 불러오지 못했습니다.")).closest(
      ".inline-notice",
    );
    expect(notice).toHaveTextContent("요청 ID: req_prompts");
  });

  it("쓰기 권한이 없으면 필터 저장과 자산 편집을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockAllEndpoints();
    render();

    const saveButton = await screen.findByRole("button", { name: /현재 필터 저장/u });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("읽기 전용으로 열려 있습니다.")).toBeInTheDocument();
  });

  it("쓰기 권한이 없으면 자산 검토 조작을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockAllEndpoints();
    render("/prompts/library?tab=assets");

    expect(await screen.findByRole("button", { name: "보안 점검 검토 제출" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "테스트 생성 승인" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "기본 리팩터링 사용" })).toBeDisabled();
  });

  it("검색 조건을 URL 쿼리에 반영해 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await screen.findByText("이 자바 코드를 리팩터링해줘");
    await user.type(screen.getByLabelText("키워드"), "refactor");
    await user.click(screen.getByRole("button", { name: "검색" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.key === "GET /admin/prompts").at(-1)?.options.query).toEqual({
        limit: 100,
        q: "refactor",
      }),
    );
  });

  it("자산 탭에서 삭제를 확인하면 서버 삭제를 호출한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets");

    const deleteButton = await screen.findByRole("button", { name: "기본 리팩터링 삭제" });
    const table = screen.getByRole("table", { name: "프롬프트 자산 목록" });
    expect(within(table).getByText("조직 표준")).toBeInTheDocument();

    await user.click(deleteButton);
    expect(await screen.findByRole("heading", { name: "프롬프트 자산을 삭제할까요?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "삭제", hidden: false }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "DELETE /admin/templates/refactor-basic")).toBe(true),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("프롬프트 자산을 삭제했습니다."));
  });

  it("자산 탭에서 초안을 검토 제출한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets");

    await user.click(await screen.findByRole("button", { name: "보안 점검 검토 제출" }));
    expect(await screen.findByRole("heading", { name: "검토를 제출할까요?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "검토 제출", hidden: false }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/templates/security-review/submit")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("검토를 요청했습니다."));
  });

  it("검토 대기 자산은 사유를 받은 뒤에만 승인한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets");

    await user.click(await screen.findByRole("button", { name: "테스트 생성 승인" }));
    const confirm = await screen.findByRole("button", { name: "승인", hidden: false });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/변경 사유/u), "품질 기준 통과");
    await user.click(confirm);

    await waitFor(() =>
      expect(api.bodies("POST /admin/templates/test-gen/approve")).toEqual([
        { status: "approved", note: "품질 기준 통과" },
      ]),
    );
  });

  it("자산 편집은 부분 수정(PATCH)으로 저장한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets");

    await user.click(await screen.findByRole("button", { name: "기본 리팩터링 편집" }));
    const dialog = await screen.findByRole("dialog", { name: "프롬프트 자산 편집" });
    const nameInput = within(dialog).getByLabelText(/^이름/u);
    await user.clear(nameInput);
    await user.type(nameInput, "기본 리팩터링 v2");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(api.bodies("PATCH /admin/templates/refactor-basic")).toEqual([
        {
          name: "기본 리팩터링 v2",
          category: "refactor",
          description: "레거시 자바 코드를 정리하는 표준 프롬프트",
          body: "다음 코드를 읽고 가독성을 높여 리팩터링하세요.",
          tags: ["java", "refactor"],
          note: "",
        },
      ]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("프롬프트 자산을 수정했습니다."));
  });

  it("사용 스위치를 끄면 enabled 만 부분 수정한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets");

    await user.click(await screen.findByRole("switch", { name: "기본 리팩터링 사용" }));

    await waitFor(() =>
      expect(api.bodies("PATCH /admin/templates/refactor-basic")).toEqual([{ enabled: false }]),
    );
  });

  it("자산 상세에서 버전 이력과 팀별 사용 현황을 보여주고 이전 버전으로 복원한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render("/prompts/library?tab=assets&asset=refactor-basic");

    expect(await screen.findByText("platform")).toBeInTheDocument();
    const usageTable = screen.getByRole("table", { name: "팀별 사용 현황" });
    expect(within(usageTable).getByText("120")).toBeInTheDocument();

    const versionTable = screen.getByRole("table", { name: "버전 이력" });
    expect(within(versionTable).getByText("v2")).toBeInTheDocument();
    expect(within(versionTable).getByText("현재")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "v1으로 복원" }));
    expect(await screen.findByRole("heading", { name: "이전 버전으로 복원할까요?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "복원", hidden: false }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/templates/refactor-basic/rollback")).toEqual([{ version: 1 }]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("이전 버전으로 복원했습니다."));
  });

  it("자산 상세에서 사용 기록을 남기고 본문을 복사한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render("/prompts/library?tab=assets&asset=refactor-basic");

    await user.click(await screen.findByRole("button", { name: /사용 기록 남기고 복사/u }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/templates/refactor-basic/use")).toBe(true),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("다음 코드를 읽고 가독성을 높여 리팩터링하세요."),
    );
  });

  it("URL 쿼리에서 탭과 부채 기간을 복원한다", async () => {
    const api = mockAllEndpoints();
    render("/prompts/library?tab=debt&debt_window=7d");

    expect(await screen.findByRole("tab", { name: "프롬프트 부채", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("실패 다발")).toBeInTheDocument();
    expect(api.calls.find((call) => call.key === "GET /admin/prompts/debt")?.options.query).toEqual({
      window: "7d",
      limit: 50,
    });
    expect(screen.getByLabelText("프롬프트 부채 기간")).toHaveValue("7d");
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByText("이 자바 코드를 리팩터링해줘");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
