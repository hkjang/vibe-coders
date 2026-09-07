import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetsPage } from "@/features/governance/assets/AssetsPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const sbomResponse = {
  total: 3,
  by_type: { skill: 2, workflow: 1 },
  gap_count: 1,
  entries: [
    {
      type: "skill",
      id: "sql-review",
      name: "sql-review",
      owner: "(미지정)",
      status: "production",
      deps: "model: gpt-* · tool: *",
      gaps: ["owner 없음", "검증 미흡(0/3)"],
    },
    {
      type: "skill",
      id: "code-review",
      name: "code-review",
      owner: "platform",
      status: "production",
      deps: "model: * · tool: *",
      gaps: [],
    },
    {
      type: "workflow",
      id: "wf_release",
      name: "release-notes",
      owner: "growth",
      status: "enabled",
      deps: "3 step",
      gaps: [],
    },
  ],
  note: "게이트웨이가 관리하는 AI 자산의 소유권·상태·의존성 명세입니다.",
};

const profile = {
  user_id: "usr_alice",
  team: "platform",
  role: "developer",
  requests: 420,
  total_cost_krw: 88000,
  avg_cost_per_request: 209.5,
  avg_latency_ms: 1320,
  success_rate: 0.97,
  error_rate: 0.03,
  cache_rate: 0.41,
  text2sql_usage_rate: 0.12,
  mcp_usage_rate: 0.22,
  risk_score: 72,
  distinct_models: 4,
  distinct_prompt_fingerprints: 31,
  top_task_types: [{ key: "code_review", requests: 210 }],
  top_models: [{ key: "gpt-4o-mini", requests: 260 }],
  top_languages: [{ key: "go", requests: 180 }],
  top_mcp_tools: [{ key: "github/search", requests: 40 }],
  summary: "코드 리뷰 중심의 안정적인 사용 패턴",
  since: "2026-08-08T00:00:00Z",
};

const profilesResponse = { profiles: [profile] };
const coachingResponse = {
  items: [
    {
      user_id: "usr_alice",
      team: "platform",
      role: "developer",
      category: "cost",
      severity: "medium",
      score: 64,
      title: "요청당 비용이 팀 평균보다 높습니다",
      detail: "경량 모델 전환을 검토하세요.",
      reason: "avg_cost_per_request=209.5",
    },
  ],
  count: 1,
};
const hintsResponse = {
  items: [
    {
      user_id: "usr_alice",
      team: "platform",
      fingerprint: "fp_9f2",
      schema_name: "analytics",
      count: 8,
      success_rate: 0.75,
      avg_cost_krw: 12.5,
      estimated_savings_krw: 4200,
      last_seen: "2026-09-05T10:00:00Z",
      recommended_product: "saved_report",
      hint_type: "저장 리포트",
      reason: "반복 8회",
    },
  ],
  count: 1,
};
const adoptionResponse = {
  by_kind: [{ kind: "model_switch", adopted: 7, dismissed: 3, distinct_adopters: 4, adoption_rate: 0.7 }],
  total_adopted: 7,
  total_dismissed: 3,
  overall_adoption_rate: 0.7,
};
const modelAffinityResponse = {
  items: [
    {
      user_id: "usr_alice",
      team: "platform",
      role: "developer",
      model: "gpt-4o-mini",
      requests: 260,
      avg_cost_krw: 180.2,
      success_rate: 0.98,
      score: 88,
      reason: "성공률과 비용이 모두 우수",
    },
  ],
  count: 1,
};
const mcpAffinityResponse = {
  items: [
    {
      user_id: "usr_alice",
      team: "platform",
      role: "developer",
      server_label: "github",
      tool_name: "search",
      ref: "github/search",
      calls: 40,
      errors: 1,
      success_rate: 0.975,
      avg_request_latency_ms: 820,
      score: 81,
      reason: "호출량 대비 오류가 적음",
    },
  ],
  count: 1,
};
const profileDetailResponse = {
  profile,
  snapshots: [
    { id: "pps_2", profile: JSON.stringify(profile), created_at: "2026-09-06T09:00:00Z" },
    {
      id: "pps_1",
      profile: JSON.stringify({ ...profile, requests: 300, total_cost_krw: 61000 }),
      created_at: "2026-08-30T09:00:00Z",
    },
  ],
  drift: {
    user_id: "usr_alice",
    has_baseline: true,
    from: "2026-08-30T09:00:00Z",
    to: "2026-09-06T09:00:00Z",
    requests_delta: 120,
    cost_delta_krw: 27000,
    avg_cost_delta_krw: 1.4,
    success_rate_delta: 0.02,
    top_model_from: "gpt-4o",
    top_model_to: "gpt-4o-mini",
    top_model_changed: true,
    top_task_from: "code_review",
    top_task_to: "code_review",
    top_task_changed: false,
    flags: ["모델 전환"],
  },
};

const personalizationHandlers = {
  "GET /admin/personalization/profiles": () => profilesResponse,
  "GET /admin/personalization/coaching": () => coachingResponse,
  "GET /admin/personalization/text2sql-hints": () => hintsResponse,
  "GET /admin/recommendations/adoption": () => adoptionResponse,
  "GET /admin/personalization/model-affinity": () => modelAffinityResponse,
  "GET /admin/personalization/mcp-affinity": () => mcpAffinityResponse,
  "GET /admin/personalization/profiles/usr_alice": () => profileDetailResponse,
  "POST /admin/personalization/profiles/usr_alice": () => profileDetailResponse,
};

function mockAllEndpoints(overrides: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /admin/sbom": () => sbomResponse,
    ...personalizationHandlers,
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/governance/assets") {
  return renderScreen(<AssetsPage />, { route, path: "/governance/assets" });
}

describe("AssetsPage", () => {
  it("SBOM 탭에 자산 명세와 거버넌스 공백을 표시한다", async () => {
    mockAllEndpoints();
    render();

    const row = await screen.findByRole("row", { name: /sql-review/u });
    expect(within(row).getByText("미지정")).toBeInTheDocument();
    expect(within(row).getByText("owner 없음")).toBeInTheDocument();
    expect(screen.getByText("거버넌스 공백").closest(".stat-card")).toHaveTextContent("1");
  });

  it("자산이 없으면 빈 상태를 안내한다", async () => {
    mockAllEndpoints({
      "GET /admin/sbom": () => ({ total: 0, by_type: {}, gap_count: 0, entries: [], note: "" }),
    });
    render();

    expect(await screen.findByText("등록된 AI 자산이 없습니다.")).toBeInTheDocument();
  });

  it("SBOM 조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/sbom": () => {
        throw apiFailure("sbom failed", 500, "req_sbom");
      },
    });
    render();

    const notice = (await screen.findByText("AI 자산 SBOM을(를) 불러오지 못했습니다.")).closest(
      ".inline-notice",
    );
    expect(notice).toHaveTextContent("요청 ID: req_sbom");
  });

  it("admin:read 권한이 없으면 JSON 내보내기를 비활성화한다", async () => {
    authRuntime.scopes = ["observability:read"];
    mockAllEndpoints();
    render();

    const button = await screen.findByRole("button", { name: /JSON 내보내기/u });
    expect(button).toBeDisabled();
    expect(screen.getByText("읽기 권한이 없습니다.")).toBeInTheDocument();
  });

  it("URL 쿼리에서 탭과 자산 유형 필터를 복원한다", async () => {
    mockAllEndpoints();
    render("/governance/assets?type=workflow");

    expect(await screen.findByText("release-notes")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "AI 자산 SBOM" });
    expect(within(table).queryByText("sql-review")).not.toBeInTheDocument();
    expect(screen.getByLabelText("자산 유형")).toHaveValue("workflow");
  });

  it("개인화 탭을 URL에서 복원하고 조회 기간을 함께 보낸다", async () => {
    const api = mockAllEndpoints();
    render("/governance/assets?tab=personalization&window=7d");

    await screen.findByText("코드 리뷰 중심의 안정적인 사용 패턴");
    const profileTable = screen.getByRole("table", { name: "사용자 AI 프로필" });
    expect(within(profileTable).getByText("usr_alice")).toBeInTheDocument();
    expect(within(profileTable).getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(
      api.calls.find((call) => call.key === "GET /admin/personalization/profiles")?.options.query,
    ).toEqual({ window: "7d", limit: 50 });
    expect(screen.getByRole("table", { name: "개인화 코칭 후보" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "추천 채택률" })).toBeInTheDocument();
  });

  it("프로필 상세를 열고 확인 후에만 스냅샷을 생성한다", async () => {
    const api = mockAllEndpoints();
    render("/governance/assets?tab=personalization&user=usr_alice");

    expect(await screen.findByRole("heading", { name: "핵심 지표" })).toBeInTheDocument();
    expect(screen.getByText("모델 전환")).toBeInTheDocument();

    const before = api.calls.filter(
      (call) => call.key === "GET /admin/personalization/profiles/usr_alice",
    ).length;
    await userEvent.click(screen.getByRole("button", { name: /현재 상태 스냅샷/u }));
    await userEvent.click(screen.getByRole("button", { name: "스냅샷 저장" }));

    await waitFor(() =>
      expect(toastSpy.success).toHaveBeenCalledWith("현재 프로필을 스냅샷으로 저장했습니다."),
    );
    // Taking a snapshot is a POST: reading the profile must never record one.
    const snapshotCall = api.calls.find(
      (call) => call.key === "POST /admin/personalization/profiles/usr_alice",
    );
    expect(snapshotCall?.options.query).toEqual({ window: "30d" });
    expect(
      api.calls.filter((call) => call.key === "GET /admin/personalization/profiles/usr_alice").length,
    ).toBeGreaterThan(before);
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByRole("row", { name: /sql-review/u });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
