import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PoliciesPage } from "@/features/governance/policies/PoliciesPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "security:read"] as string[],
}));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const killSwitchResponse = {
  disabled: false,
  reason: "",
  updated_at: "2026-09-01T00:00:00Z",
  updated_by: "operator@example.com",
};

const incidentsResponse = {
  incidents: [
    {
      provider: "openai",
      started_at: "2026-09-05T01:00:00Z",
      ended_at: "2026-09-05T03:00:00Z",
      failovers: 22,
      errors_5xx: 41,
      affected_users: 7,
      requests: 900,
      ongoing: false,
    },
  ],
  min_events: 5,
};

const policiesResponse = {
  policies: [
    {
      id: "pol_secret",
      name: "민감정보 차단",
      description: "secret 포함 요청 차단",
      enabled: true,
      priority: 10,
      rollout_percent: 50,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      rules: [
        {
          id: "prule_1",
          policy_id: "pol_secret",
          name: "contains_secret -> block",
          enabled: true,
          priority: 100,
          conditions: { contains_secret: true },
          actions: { block: true },
        },
      ],
    },
  ],
};

const regressionCasesResponse = {
  cases: [
    {
      id: "preg_1",
      name: "비밀정보 차단 시나리오",
      description: "",
      model: "gpt-4.1",
      provider: "openai",
      team_id: "platform",
      role: "",
      endpoint: "",
      complexity_score: 0,
      risk_score: 90,
      contains_secret: true,
      secret_types: [],
      mcp_server: "",
      mcp_tool: "",
      expect: "block",
      expect_secret_action: "",
      enabled: true,
      created_by: "operator@example.com",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
};

const secretEventsResponse = {
  secret_events: [
    {
      id: "sec_1",
      request_id: "req_112233445566",
      api_key_id: "key_aabbccddeeff",
      user_id: "usr_1",
      team_id: "platform",
      secret_type: "aws_access_key",
      action: "block",
      location: "prompt",
      matched_hash: "ab12",
      created_at: "2026-09-06T02:00:00Z",
    },
  ],
  count: 1,
};

const approvalsResponse = {
  approvals: [
    {
      id: "apr_1",
      request_id: "req_998877665544",
      api_key_id: "key_aabbccddeeff",
      user_id: "usr_1",
      team_id: "platform",
      subject_type: "model",
      subject_id: "gpt-4.1",
      status: "pending",
      reason: "고비용 모델 사용",
      risk_score: 71,
      cost_krw: 12000,
      payload: "",
      expires_at: "2026-09-07T02:00:00Z",
      decided_by: "",
      decided_at: "",
      created_at: "2026-09-06T02:00:00Z",
    },
  ],
  count: 1,
};

const policyDecisionsResponse = {
  policy_decisions: [
    {
      id: "pde_1",
      request_id: "req_112233445566",
      api_key_id: "key_aabbccddeeff",
      user_id: "usr_1",
      team_id: "platform",
      endpoint: "/v1/chat/completions",
      phase: "pre",
      policy_id: "pol_secret",
      rule_id: "prule_1",
      rule_name: "contains_secret -> block",
      decision: "block",
      reason: "secret detected",
      model: "gpt-4.1",
      provider: "openai",
      risk_score: 90,
      cost_krw: 0,
      created_at: "2026-09-06T02:00:00Z",
    },
  ],
  count: 1,
};

const alertsResponse = {
  rules: [
    {
      id: "alert_1",
      name: "오류율 경보",
      metric: "errors",
      window_seconds: 300,
      threshold: 0.05,
      scope: "global",
      scope_value: "*",
      webhook_url: "https://hooks.example/1",
      enabled: true,
      note: "운영 채널로 통보",
      created_at: "2026-08-01T00:00:00Z",
      last_fired_at: "2026-09-05T10:00:00Z",
      last_value: 0.07,
    },
  ],
  events: [
    {
      id: "alev_1",
      rule_id: "alert_1",
      rule_name: "오류율 경보",
      metric: "errors",
      value: 0.07,
      threshold: 0.05,
      delivered: true,
      created_at: "2026-09-05T10:00:00Z",
    },
  ],
};

const deprecationsResponse = {
  deprecations: [
    {
      id: "moddep_1",
      model_glob: "gpt-3.5-*",
      replacement: "gpt-4.1-mini",
      sunset_date: "2026-12-31",
      message: "gpt-4.1-mini로 전환하세요.",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const suggestionsResponse = {
  window: "2026-08-31T00:00:00Z",
  note: "로그 근거로 추천된 정책 규칙입니다.",
  suggestions: [
    {
      id: "psug_1",
      title: "민감정보 차단 정책 추가",
      severity: "critical",
      rationale: "최근 12건의 secret이 탐지만 되고 차단되지 않았습니다.",
      evidence: { detect_only_events: 12 },
      conditions: { contains_secret: true },
      actions: { secret_action: "block" },
    },
  ],
};

const canaryResponse = {
  days: 7,
  note: "canary 정책 현황",
  policies: [
    {
      policy_id: "pol_secret",
      name: "민감정보 차단",
      rollout_percent: 50,
      enforced_acts: 24,
      shadow_acts: 3,
      suggested_next: 75,
    },
  ],
};

function mockAllEndpoints(overrides: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /admin/kill-switch": () => killSwitchResponse,
    "POST /admin/kill-switch": () => ({ ...killSwitchResponse, disabled: true, reason: "장애 대응" }),
    "GET /admin/incidents": () => incidentsResponse,
    "GET /admin/policies": () => policiesResponse,
    "POST /admin/policies": () => ({ policy: policiesResponse.policies[0] }),
    "GET /admin/policies/regression/cases": () => regressionCasesResponse,
    "POST /admin/policies/regression/cases": () => ({ id: "preg_2", ok: true }),
    "DELETE /admin/policies/regression/cases": () => ({ ok: true }),
    "POST /admin/policies/regression/run": () => ({
      rule_source: "active",
      rule_count: 1,
      total: 1,
      passed: 1,
      failed: 0,
      ran_at: "2026-09-07T00:00:00Z",
      results: [
        { id: "preg_1", name: "비밀정보 차단 시나리오", expect: "block", actual: "block", pass: true },
      ],
    }),
    "GET /admin/security/secrets": () => secretEventsResponse,
    "GET /admin/approvals": () => approvalsResponse,
    "POST /admin/approvals/apr_1/approve": () => ({
      approval: { ...approvalsResponse.approvals[0], status: "approved" },
    }),
    "GET /admin/policies/decisions": () => policyDecisionsResponse,
    "GET /admin/alerts": () => alertsResponse,
    "POST /admin/alerts": () => ({ rule: alertsResponse.rules[0] }),
    "DELETE /admin/alerts/alert_1": () => ({ id: "alert_1", status: "deleted" }),
    "GET /admin/model-deprecations": () => deprecationsResponse,
    "POST /admin/model-deprecations": () => ({ deprecation: deprecationsResponse.deprecations[0] }),
    "DELETE /admin/model-deprecations/moddep_1": () => ({ id: "moddep_1", status: "deleted" }),
    "GET /admin/policy-advisor/suggestions": () => suggestionsResponse,
    "POST /admin/policy-advisor/apply": () => ({ policy_id: "pol_new", enabled: false }),
    "GET /admin/policies/canary-status": () => canaryResponse,
    "POST /admin/policies/simulate": () => ({
      evaluated: 300,
      blocked: 12,
      require_approval: 4,
      allowed: 284,
      block_rate: 0.04,
      since: "2026-08-31T00:00:00Z",
      shadow: {
        affected_keys: 3,
        affected_teams: 2,
        false_positive_candidates: 1,
        false_positive_rate: 0.083,
        blocked_cost_krw: 8100,
        false_positive_sample: [],
      },
    }),
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write", "security:read"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/governance/policies") {
  return renderScreen(<PoliciesPage />, { route, path: "/governance/policies" });
}

describe("PoliciesPage", () => {
  it("안전 정책 탭에 긴급 정지 상태와 정책·승인·알림을 표시한다", async () => {
    mockAllEndpoints();
    render();

    expect(await screen.findByText("정상 운영")).toBeInTheDocument();
    expect(await screen.findByText("민감정보 차단")).toBeInTheDocument();
    expect(await screen.findByText("aws_access_key")).toBeInTheDocument();
    expect(await screen.findByText("고비용 모델 사용")).toBeInTheDocument();
    expect(await screen.findAllByText("오류율 경보")).toHaveLength(2);
    expect(screen.getByText("canary 50%")).toBeInTheDocument();
  });

  it("정책이 없으면 빈 상태를 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/policies": () => ({ policies: [] }) });
    render();

    expect(await screen.findByText("등록된 AI 정책이 없습니다.")).toBeInTheDocument();
  });

  it("긴급 정지 상태 조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/kill-switch": () => {
        throw apiFailure("kill switch failed", 500, "req_kill");
      },
    });
    render();

    const notice = (await screen.findByText("긴급 정지 상태을(를) 불러오지 못했습니다.")).closest(
      ".inline-notice",
    );
    expect(notice).toHaveTextContent("요청 ID: req_kill");
  });

  it("쓰기 권한이 없으면 긴급 정지와 승인 버튼을 비활성화한다", async () => {
    authRuntime.scopes = ["security:read"];
    mockAllEndpoints();
    render();

    const stopButton = await screen.findByRole("button", { name: /모든 \/v1 호출 즉시 차단/u });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute("title", expect.stringContaining("admin:write"));
    expect(await screen.findByRole("button", { name: "승인 요청 apr_1 승인" })).toBeDisabled();
    expect(screen.getByText("읽기 전용으로 열려 있습니다.")).toBeInTheDocument();
  });

  it("긴급 정지는 사유를 받은 뒤에만 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await screen.findByText("정상 운영");
    await user.click(screen.getByRole("button", { name: /모든 \/v1 호출 즉시 차단/u }));

    const confirm = await screen.findByRole("button", { name: "즉시 차단" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/변경 사유/u), "공급자 전면 장애");
    await user.click(confirm);

    await waitFor(() =>
      expect(api.bodies("POST /admin/kill-switch")).toEqual([{ disabled: true, reason: "공급자 전면 장애" }]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("게이트웨이를 긴급 정지했습니다."));
  });

  it("승인 큐에서 승인하면 결정 경로로 호출한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "승인 요청 apr_1 승인" }));
    await user.click(await screen.findByRole("button", { name: "승인" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/approvals/apr_1/approve")).toBe(true),
    );
  });

  it("URL 쿼리에서 탭과 조회 조건을 복원한다", async () => {
    const api = mockAllEndpoints();
    render("/governance/policies?window=7d&approval_status=approved");

    await screen.findByText("aws_access_key");
    expect(api.calls.find((call) => call.key === "GET /admin/approvals")?.options.query).toEqual({
      window: "7d",
      limit: 50,
      status: "approved",
    });
    expect(screen.getByLabelText("조회 기간")).toHaveValue("7d");
  });

  it("모델 일몰 탭에서 등록된 정책을 보여준다", async () => {
    mockAllEndpoints();
    render("/governance/policies?tab=sunset");

    expect(await screen.findByRole("tab", { name: "모델 일몰", selected: true })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "모델 일몰 정책 목록" });
    expect(within(table).getByText("gpt-3.5-*")).toBeInTheDocument();
    expect(within(table).getByText("gpt-4.1-mini")).toBeInTheDocument();
  });

  it("정책 어드바이저 탭에서 추천과 canary 현황을 보여준다", async () => {
    mockAllEndpoints();
    render("/governance/policies?tab=advisor");

    expect(await screen.findByText("민감정보 차단 정책 추가")).toBeInTheDocument();
    const canaryTable = screen.getByRole("table", { name: "canary 정책 현황" });
    expect(within(canaryTable).getByText("75%")).toBeInTheDocument();
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findAllByText("오류율 경보");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
