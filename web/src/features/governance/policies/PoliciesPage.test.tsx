import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PoliciesPage } from "@/features/governance/policies/PoliciesPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "security:read"] as string[],
  backendVersion: undefined as string | undefined,
}));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: authRuntime.scopes, backendVersion: authRuntime.backendVersion }),
  };
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

const costGuardResponse = { enabled: false, threshold_krw: 500 };

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
    "PATCH /admin/alerts/alert_1": () => ({ rule: { ...alertsResponse.rules[0], enabled: false } }),
    "DELETE /admin/alerts/alert_1": () => ({ id: "alert_1", status: "deleted" }),
    "GET /admin/cost": () => costGuardResponse,
    "POST /admin/cost": () => ({ enabled: true, threshold_krw: 900 }),
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
  authRuntime.backendVersion = undefined;
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
  it("구버전에서는 비용 설정만 막고 기존 정책 편집은 유지한다", async () => {
    authRuntime.backendVersion = "v0.86.14";
    const api = mockAllEndpoints();
    render();
    expect(await screen.findByText("비용 보호 설정의 서버 버전을 확인하세요.")).toBeVisible();
    expect(screen.getByRole("button", { name: "비용 보호 설정 수정" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "정책 추가" })).toBeEnabled();
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("안전 정책 탭에 긴급 정지 상태와 정책·승인·알림을 표시한다", async () => {
    mockAllEndpoints();
    render();

    expect(await screen.findByText("정상 운영")).toBeInTheDocument();
    expect(await screen.findByText("민감정보 차단")).toBeInTheDocument();
    expect(await screen.findByText("aws_access_key")).toBeInTheDocument();
    expect(await screen.findByText("고비용 모델 사용")).toBeInTheDocument();
    expect(await screen.findAllByText("오류율 경보")).toHaveLength(2);
    expect(screen.getByText("점진 적용 50%")).toBeInTheDocument();
    const cases = screen.getByRole("table", { name: "정책 회귀 시나리오" });
    expect(within(cases).getByRole("columnheader", { name: "위험 점수" })).toBeVisible();
    expect(within(cases).getByRole("columnheader", { name: "비밀정보" })).toBeVisible();
    expect(within(cases).getByText("차단")).toBeVisible();
  });

  it("한글 정책 조건과 동작을 골라도 서버의 규칙 코드를 그대로 전송한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "정책 추가" }));
    const dialog = await screen.findByRole("dialog", { name: "AI 정책 추가" });
    await user.type(within(dialog).getByLabelText(/^정책 이름/u), "공급자 제한");
    const condition = within(dialog).getByRole("combobox", { name: "조건" });
    const action = within(dialog).getByRole("combobox", { name: "동작" });
    expect(within(condition).getByRole("option", { name: "비밀정보 포함" })).toHaveValue("contains_secret");
    expect(within(action).getByRole("option", { name: "비밀정보 가리기" })).toHaveValue("secret_mask");
    await user.selectOptions(condition, within(condition).getByRole("option", { name: "팀" }));
    await user.type(within(dialog).getByLabelText("조건값"), "platform");
    await user.selectOptions(action, within(action).getByRole("option", { name: "공급자 허용" }));
    await user.type(within(dialog).getByLabelText("동작 대상"), "provider-a,provider-b");
    await user.click(within(dialog).getByRole("button", { name: "정책 저장" }));

    await waitFor(() => expect(api.bodies("POST /admin/policies")).toHaveLength(1));
    expect(api.bodies("POST /admin/policies")[0]).toMatchObject({
      name: "공급자 제한",
      rules: [
        { conditions: { team: "platform" }, actions: { allow_providers: ["provider-a", "provider-b"] } },
      ],
    });
  });

  it("한글 기대 결과를 선택한 회귀 시나리오에 기존 판단 코드를 저장한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "시나리오 추가" }));
    const dialog = await screen.findByRole("dialog", { name: "회귀 시나리오 추가" });
    await user.type(within(dialog).getByLabelText(/^시나리오 이름/u), "승인 필요 확인");
    const result = within(dialog).getByRole("combobox", { name: "기대 결과" });
    await user.selectOptions(result, within(result).getByRole("option", { name: "승인 필요" }));
    await user.click(within(dialog).getByRole("button", { name: "시나리오 저장" }));

    await waitFor(() => expect(api.bodies("POST /admin/policies/regression/cases")).toHaveLength(1));
    expect(api.bodies("POST /admin/policies/regression/cases")[0]).toMatchObject({
      name: "승인 필요 확인",
      expect: "require_approval",
      risk_score: 0,
    });
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
    expect(screen.getByRole("switch", { name: "오류율 경보 사용" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "오류율 경보 알림 규칙 수정" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "비용 보호 설정 수정" })).toBeDisabled();
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

  it("알림 규칙의 임계값과 Webhook을 부분 수정한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "오류율 경보 알림 규칙 수정" }));
    const dialog = await screen.findByRole("dialog", { name: "알림 규칙 수정" });
    const threshold = within(dialog).getByLabelText(/^임계값/u);
    await user.clear(threshold);
    await user.type(threshold, "0.1");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(api.bodies("PATCH /admin/alerts/alert_1")).toEqual([
        { threshold: 0.1, webhook_url: "https://hooks.example/1", note: "운영 채널로 통보" },
      ]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("알림 규칙을 수정했습니다."));
  });

  it("알림 규칙 스위치를 끄면 enabled 만 부분 수정한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("switch", { name: "오류율 경보 사용" }));

    await waitFor(() => expect(api.bodies("PATCH /admin/alerts/alert_1")).toEqual([{ enabled: false }]));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("알림 규칙을 중지했습니다."));
  });

  it("확인된 비용 보호 설정을 대화상자에서 저장한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    const edit = await screen.findByRole("button", { name: "비용 보호 설정 수정" });
    await waitFor(() => expect(edit).toBeEnabled());
    await user.click(edit);
    const threshold = await screen.findByLabelText(/요청당 임계값/u);
    await waitFor(() => expect(threshold).toHaveValue(500));
    await user.click(screen.getByRole("switch", { name: "예상 비용 보호 사용" }));
    await user.clear(threshold);
    await user.type(threshold, "900");
    await user.click(screen.getByRole("button", { name: "비용 보호 설정 저장" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/cost")).toEqual([{ enabled: true, threshold_krw: 900 }]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("비용 보호 설정을 저장했습니다."));
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
