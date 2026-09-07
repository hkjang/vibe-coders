import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportsPage } from "@/features/governance/reports/ReportsPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const scorecardResponse = {
  window: "2026-08-08T00:00:00Z",
  generated_at: "2026-09-07T02:00:00Z",
  teams: [
    {
      team: "platform",
      requests: 1240,
      cost_krw: 318000,
      cost_efficiency: 82,
      success_rate: 97,
      cache_rate: 41,
      skill_reuse: 55,
      mcp_success: 91,
      text2sql_success: -1,
      policy_compliance: 99,
      satisfaction: 78,
      overall: 77.6,
      grade: "B",
    },
    {
      team: "growth",
      requests: 310,
      cost_krw: 91000,
      cost_efficiency: 40,
      success_rate: 88,
      cache_rate: 12,
      skill_reuse: -1,
      mcp_success: -1,
      text2sql_success: -1,
      policy_compliance: 70,
      satisfaction: -1,
      overall: 52.5,
      grade: "D",
    },
  ],
  note: "팀별 AI 성숙도 점수(0~100). -1은 데이터 없음(평균 제외).",
};

const narrativeResponse = {
  period_start: "2026-08-08T00:00:00Z",
  period_end: "2026-09-07T00:00:00Z",
  generated_at: "2026-09-07T02:00:00Z",
  sections: [
    {
      title: "요약",
      narrative: "최근 30일 동안 게이트웨이는 총 1,550건의 요청을 처리했고 비용은 ₩409,000입니다.",
      metrics: { requests: 1550, cost_krw: 409000, requests_delta_pct: 12.4 },
    },
    { title: "권고", narrative: "특이사항이 없습니다.", metrics: { items: ["특이사항이 없습니다."] } },
  ],
  note: "기존 집계를 합성한 월간 운영 보고서입니다.",
};

const productivityResponse = {
  days: 30,
  repos: [
    {
      repo: "vibe-coders",
      ai_requests: 900,
      ai_tokens: 1_200_000,
      ai_cost_krw: 240000,
      commits: 120,
      merge_requests: 30,
      merged: 24,
      cost_per_merged_krw: 10000,
    },
  ],
  totals: { ai_requests: 900, merged: 24, ai_cost_krw: 240000 },
  note: "X-Vibe-Repo로 귀속된 AI 사용량과 VCS 이벤트를 repo별로 상관 분석합니다.",
};

const benchmarkUsersResponse = {
  users: [
    {
      api_key_id: "key_abcdef123456",
      name: "김개발",
      team: "platform",
      requests: 420,
      sessions: 33,
      active_days: 18,
      commits: 60,
      merged_mrs: 12,
      tool_calls: 90,
      success_rate: 0.97,
      cost_krw: 88000,
      score: 74,
    },
  ],
};

const benchmarkTeamsResponse = {
  teams: [
    {
      team: "platform",
      active_users: 6,
      requests: 1240,
      tokens: 2_400_000,
      cost_krw: 318000,
      success_rate: 0.97,
      commits: 210,
      merged_mrs: 40,
      score: 71,
    },
  ],
};

function mockAllEndpoints(overrides: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /admin/teams/scorecard": () => scorecardResponse,
    "GET /admin/reports/narrative": () => narrativeResponse,
    "GET /admin/productivity": () => productivityResponse,
    "GET /admin/benchmark/users": () => benchmarkUsersResponse,
    "GET /admin/benchmark/teams": () => benchmarkTeamsResponse,
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

function render(route = "/governance/reports") {
  return renderScreen(<ReportsPage />, { route, path: "/governance/reports" });
}

describe("ReportsPage", () => {
  it("팀 성숙도 탭에 팀별 점수와 요약 지표를 표시한다", async () => {
    mockAllEndpoints();
    render();

    const platformRow = await screen.findByRole("row", { name: /platform/u });
    expect(within(platformRow).getByText("B")).toBeInTheDocument();
    expect(within(platformRow).getByText("1,240")).toBeInTheDocument();
    // 77.6 overall and the 78 satisfaction score both round to 78.
    expect(within(platformRow).getAllByText("78")).toHaveLength(2);
    // -1 dimensions must never render as a score.
    expect(within(platformRow).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("평가 팀").closest(".stat-card")).toHaveTextContent("2");
  });

  it("팀 데이터가 없으면 빈 상태를 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/teams/scorecard": () => ({ teams: [], note: "" }) });
    render();

    expect(await screen.findByText("아직 점수를 매길 팀이 없습니다.")).toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/teams/scorecard": () => {
        throw apiFailure("scorecard failed", 500, "req_scorecard");
      },
    });
    render();

    const notice = (await screen.findByText("팀 성숙도을(를) 불러오지 못했습니다.")).closest(
      ".inline-notice",
    );
    expect(notice).toHaveTextContent("요청 ID: req_scorecard");
    expect(notice).toHaveTextContent("서버가 요청을 처리하지 못했습니다.");
  });

  it("admin:read 권한이 없으면 내보내기 버튼을 비활성화하고 사유를 표시한다", async () => {
    authRuntime.scopes = ["observability:read"];
    mockAllEndpoints();
    render();

    const button = await screen.findByRole("button", { name: /CSV 다운로드/u });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("admin:read"));
    expect(screen.getByText("읽기 권한이 없습니다.")).toBeInTheDocument();
  });

  it("CSV 다운로드가 서버 내보내기를 인증 헤더와 함께 호출한다", async () => {
    mockAllEndpoints();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("team,requests\n", { status: 200 }));
    render("/governance/reports?window=7d");

    await screen.findByRole("row", { name: /platform/u });
    await userEvent.click(screen.getByRole("button", { name: /CSV 다운로드/u }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/admin/teams/scorecard?window=7d&format=csv");
    expect(new Headers(init.headers).get("X-Vibe-UI")).toBe("app");
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
  });

  it("운영 보고서 탭에서 서술 구간과 기간을 보여준다", async () => {
    mockAllEndpoints();
    render("/governance/reports?tab=narrative");

    expect(await screen.findByRole("heading", { name: "월간 운영 서술 보고서" })).toBeInTheDocument();
    expect(await screen.findByText(/총 1,550건의 요청을 처리했고/u)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "권고" })).toBeInTheDocument();
  });

  it("URL 쿼리에서 탭과 조회 기간을 복원한다", async () => {
    const api = mockAllEndpoints();
    render("/governance/reports?tab=productivity&window=7d");

    expect(await screen.findByRole("tab", { name: "AI 업무성과", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /vibe-coders/u })).toBeInTheDocument();
    expect(api.calls.find((call) => call.key === "GET /admin/productivity")?.options.query).toEqual({
      days: 7,
    });
    expect(api.calls.find((call) => call.key === "GET /admin/benchmark/users")?.options.query).toEqual({
      window: "7d",
      limit: 50,
    });
    expect(screen.getByLabelText("조회 기간")).toHaveValue("7d");
  });

  it("AI 업무성과 탭에서 벤치마크 표를 함께 보여준다", async () => {
    mockAllEndpoints();
    render("/governance/reports?tab=productivity");

    // The score bars and the table both label the top user.
    await screen.findAllByText("김개발");
    const userTable = screen.getByRole("table", { name: "사용자 AI 활용지수" });
    expect(within(userTable).getByText("김개발")).toBeInTheDocument();
    expect(within(userTable).getByText("key_abcdef12…")).toBeInTheDocument();
    const teamTable = screen.getByRole("table", { name: "팀 벤치마크" });
    expect(within(teamTable).getByText("platform")).toBeInTheDocument();
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByRole("row", { name: /platform/u });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
