import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoutingPage } from "@/features/routing/rules/RoutingPage";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "routing:read", "routing:write"] as string[],
}));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const providerRef = `prv_${"a".repeat(43)}`;

const rule = {
  id: "route_1",
  enabled: true,
  priority: 10,
  match_pattern: "gpt-*",
  min_complexity: 0,
  max_complexity: 40,
  target_model: "gpt-4.1-mini",
  target_provider: "openai",
  note: "단순 요청은 저비용 모델로",
  created_at: "2026-09-01T00:00:00Z",
};

const healthResponse = {
  since: "2026-09-06T00:00:00Z",
  until: "2026-09-07T00:00:00Z",
  threshold: 70,
  providers: [
    {
      provider: "openai",
      provider_ref: providerRef,
      score: 55,
      requests: 1200,
      average_latency_ms: 820.5,
      p95_latency_ms: 1900,
      timeouts: 2,
      rate_429: 1,
      rate_5xx: 0,
      fallbacks: 30,
      fallback_rate: 0.025,
    },
  ],
  ranking: [
    {
      rank: 1,
      provider: "openai",
      provider_ref: providerRef,
      score: 55,
      requests: 1200,
      average_latency_ms: 820.5,
      p95_latency_ms: 1900,
      timeouts: 2,
      rate_429: 1,
      rate_5xx: 0,
      fallbacks: 30,
      fallback_rate: 0.025,
    },
  ],
  degraded: [],
  alerts: [
    {
      provider: "openai",
      provider_ref: providerRef,
      code: "provider_degraded",
      severity: "warning",
      message: "provider health score is below threshold",
    },
  ],
  trend: [],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    shared: false,
    instance_id: "gw-1",
    states: [
      {
        provider: "openai",
        provider_ref: providerRef,
        phase: "open",
        failures: 6,
        opens: 2,
        last_reason: "upstream_5xx",
        last_failure_at: "2026-09-07T00:00:00Z",
        opened_at: "2026-09-07T00:00:10Z",
        retry_in_seconds: 12,
      },
    ],
  },
};

const balancerResponse = {
  mode: "round_robin",
  multi_instance_safe: false,
  sticky_sessions: true,
  sticky_ttl: "30m0s",
  active_sessions: 4,
  window_since: "2026-09-06T00:00:00Z",
  model: "",
  pools: [{ pattern: "gpt-*", providers: ["openai", "azure"], size: 2, balanced: true }],
  intent: [{ provider: "openai", picks: 120, share: 0.6, sessions: 3 }],
  actual: [{ provider: "openai", requests: 100, failovers: 2, errors: 1, avg_latency_ms: 700 }],
  balance_index: 0.42,
};

const decisionsResponse = {
  decisions: [
    {
      id: "rd_1",
      request_id: "req_abc",
      trace_id: "tr_abc",
      requested_model: "gpt-4.1",
      selected_model: "gpt-4.1-mini",
      selected_provider: "openai",
      complexity: { score: 12, tier: "low" },
      risk: { score: 3, tier: "low", categories: [] },
      health_score: 88,
      fallback_path: ["timeout:openai->azure"],
      decision_reason: "complexity_rule",
      created_at: "2026-09-07T01:00:00Z",
    },
  ],
};

const patternResponse = {
  generated_at: "2026-09-07T01:00:00Z",
  focus_provider: "",
  summary: {
    provider_count: 2,
    enabled_provider_count: 2,
    pattern_count: 3,
    conflict_count: 1,
    high_conflict_count: 0,
    medium_conflict_count: 1,
    affected_provider_count: 2,
    redundant_pattern_count: 0,
    focus_conflict_count: 0,
    failover_ready_provider_count: 1,
    failover_uncovered_provider_count: 1,
  },
  conflicts: [
    {
      id: "cft_1",
      type: "overlap",
      severity: "warning",
      candidates: [
        { provider: "openai", pattern: "gpt-*" },
        { provider: "azure", pattern: "gpt-4*" },
      ],
      witness_model: "gpt-4.1",
      selected_provider: "openai",
      selected_pattern: "gpt-*",
      decision_reason: "priority",
    },
  ],
  redundancies: [],
  coverage: [
    {
      provider: "openai",
      patterns: ["gpt-*"],
      failover_group: "premium",
      failover_peers: ["azure"],
      failover_ready: true,
      peer_source: "failover_group",
    },
    {
      provider: "local",
      patterns: ["local/*"],
      failover_group: "",
      failover_peers: [],
      failover_ready: false,
      peer_source: "",
    },
  ],
  resolution_policy: { mode: "priority", order: ["priority", "name"], description: "우선순위 순" },
  default_provider: "openai",
  default_provider_has_patterns: true,
};

const learningResponse = {
  since: "2026-08-31T00:00:00Z",
  min_samples: 20,
  cells: [
    {
      task_type: "coding",
      bucket: "low",
      model: "gpt-4.1",
      requests: 120,
      successes: 110,
      success_rate: 0.91,
      fallback_rate: 0.02,
      avg_cost_krw: 12.5,
      avg_latency_ms: 900,
      thumbs_up: 4,
      thumbs_down: 1,
    },
  ],
  recommendations: [
    {
      task_type: "coding",
      bucket: "low",
      recommended_model: "gpt-4.1-mini",
      success_rate: 0.94,
      avg_cost_krw: 3.2,
      samples: 80,
      top_model: "gpt-4.1",
      top_success_rate: 0.91,
      differs: true,
      confident: true,
      rationale: "성공률이 높고 비용이 낮습니다.",
    },
  ],
};

const domainDecisionsResponse = {
  decisions: [
    {
      id: "dd_1",
      request_id: "req_zzz",
      user_id: "u1",
      team_id: "t1",
      route: "sql",
      confidence: 0.62,
      tool_names: ["sql_runner"],
      evidence_score: 1.4,
      evidence_count: 3,
      fallback_used: false,
      blocked_by_governance: false,
      reason: "keyword_match",
      created_at: "2026-09-07T00:30:00Z",
    },
  ],
  signals: {},
};

const reviewResponse = {
  items: [
    {
      id: "rv_1",
      decision_id: "dd_1",
      suggested_route: "sql",
      current_route: "general",
      reason: "low_confidence",
      status: "pending",
      created_at: "2026-09-07T00:31:00Z",
      reviewed_at: "",
    },
  ],
};

function mockAllEndpoints(overrides: Readonly<Record<string, ApiHandler>> = {}) {
  return mockApi({
    "GET /admin/routing-rules": () => ({ rules: [rule] }),
    "POST /admin/routing-rules": () => ({ rule }),
    "DELETE /admin/routing-rules/route_1": () => ({ id: "route_1", status: "deleted" }),
    "PATCH /admin/routing-rules/route_1": (options) => ({
      rule: { ...rule, ...(options.body as { enabled: boolean }) },
    }),
    "GET /admin/routing/health": () => healthResponse,
    "GET /admin/routing/balancer": () => balancerResponse,
    "POST /admin/routing/breaker-reset": () => ({
      status: "reset",
      provider: "openai",
      states: [],
    }),
    "POST /admin/routing/balancer": () => ({
      status: "released",
      provider: "openai",
      released_sessions: 3,
    }),
    "GET /admin/routing/decisions": () => decisionsResponse,
    "GET /admin/routing/pattern-conflicts": () => patternResponse,
    "POST /admin/routing/failover-drill": () => ({
      model: "gpt-4.1",
      candidates: ["openai", "azure"],
      failed_input: ["openai"],
      health_demoted: [],
      steps: [
        { provider: "openai", outcome: "simulated_failure", detail: "드릴에서 실패로 지정됨" },
        { provider: "azure", outcome: "served", detail: "" },
      ],
      served_by: "azure",
      outcome: "served",
      advice: "",
      breaker_enabled: true,
    }),
    "GET /admin/providers": () => ({
      providers: [
        {
          name: "openai",
          provider_ref: providerRef,
          base_url: "https://api.openai.example/v1",
          api_key_configured: true,
          timeout_ms: 30_000,
          enabled: true,
          model_patterns: "gpt-*",
          failover_group: "premium",
          priority: 10,
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
    }),
    "GET /admin/routing/learning": () => learningResponse,
    "GET /admin/routing/domain-decisions": () => domainDecisionsResponse,
    "GET /admin/routing/domain-review": () => reviewResponse,
    "GET /admin/routing/domain-examples": () => ({ examples: [] }),
    // pathWithParams percent-encodes the action separator; the Go mux decodes it
    // back to "<id>/approve" before the handler reads r.URL.Path.
    "POST /admin/routing/domain-review/rv_1%2Fapprove": () => ({ id: "rv_1", status: "approved" }),
    "GET /admin/cost": () => ({ enabled: true, threshold_krw: 500 }),
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write", "routing:read", "routing:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/routing/rules") {
  return renderScreen(<RoutingPage />, { route, path: "/routing/rules/*" });
}

describe("RoutingPage", () => {
  it("라우팅 규칙 목록을 보여준다", async () => {
    mockAllEndpoints();
    render();

    const row = await screen.findByRole("row", { name: /gpt-4.1-mini/u });
    expect(within(row).getByText("gpt-*")).toBeInTheDocument();
    expect(within(row).getByText("0–40")).toBeInTheDocument();
    expect(within(row).getByText("사용 중")).toBeInTheDocument();
  });

  it("규칙이 없으면 무엇을 만들면 되는지 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/routing-rules": () => ({ rules: [] }) });
    render();

    expect(
      await screen.findByText(
        "등록된 라우팅 규칙이 없습니다. 규칙을 추가하면 복잡도에 따라 모델을 자동으로 바꿉니다.",
      ),
    ).toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/routing-rules": () => {
        throw apiFailure("rules failed", 500, "req_route_1");
      },
    });
    render();

    const alerts = await screen.findAllByRole("alert");
    const notice = alerts.find((element) =>
      element.textContent?.includes("라우팅 규칙을(를) 불러오지 못했습니다."),
    );
    expect(notice).toBeDefined();
    expect(notice).toHaveTextContent("요청 ID: req_route_1");
  });

  it("routing:write 권한이 없으면 변경 버튼을 사유와 함께 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    mockAllEndpoints();
    render();

    const createButton = await screen.findByRole("button", { name: /규칙 추가/u });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", expect.stringContaining("routing:write"));
    expect(await screen.findByRole("button", { name: "gpt-* → gpt-4.1-mini 규칙 삭제" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "gpt-* → gpt-4.1-mini 규칙 중지" })).toBeDisabled();
    expect(screen.getByText(/라우팅 변경 권한\(routing:write\)/u)).toBeInTheDocument();
  });

  it("규칙 삭제를 확인하면 삭제 API를 호출하고 결과를 알린다", async () => {
    const api = mockAllEndpoints();
    render();

    await userEvent.click(await screen.findByRole("button", { name: "gpt-* → gpt-4.1-mini 규칙 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "DELETE /admin/routing-rules/route_1")).toBe(true),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("라우팅 규칙을 삭제했습니다."));
  });

  it("규칙 사용을 중지하면 enabled=false 를 보내고 결과를 알린다", async () => {
    const api = mockAllEndpoints();
    render();

    await userEvent.click(await screen.findByRole("button", { name: "gpt-* → gpt-4.1-mini 규칙 중지" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("라우팅 규칙 중지");
    await userEvent.click(within(dialog).getByRole("button", { name: "중지" }));

    await waitFor(() => expect(api.bodies("PATCH /admin/routing-rules/route_1")).toHaveLength(1));
    expect(api.bodies("PATCH /admin/routing-rules/route_1")[0]).toEqual({ enabled: false });
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("규칙 사용을 중지했습니다."));
  });

  it("중지된 규칙은 다시 사용으로 되돌릴 수 있다", async () => {
    const api = mockAllEndpoints({
      "GET /admin/routing-rules": () => ({ rules: [{ ...rule, enabled: false }] }),
    });
    render();

    await userEvent.click(await screen.findByRole("button", { name: "gpt-* → gpt-4.1-mini 규칙 사용" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "사용" }));

    await waitFor(() =>
      expect(api.bodies("PATCH /admin/routing-rules/route_1")[0]).toEqual({ enabled: true }),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("규칙을 다시 사용합니다."));
  });

  it("규칙을 추가하면 입력한 값을 그대로 보낸다", async () => {
    const api = mockAllEndpoints();
    render();

    await userEvent.click(await screen.findByRole("button", { name: /규칙 추가/u }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/대상 모델/u), "gpt-4.1-nano");
    await userEvent.click(within(dialog).getByRole("button", { name: "규칙 만들기" }));

    await waitFor(() => expect(api.bodies("POST /admin/routing-rules")).toHaveLength(1));
    expect(api.bodies("POST /admin/routing-rules")[0]).toMatchObject({
      match_pattern: "*",
      target_model: "gpt-4.1-nano",
      min_complexity: 0,
      max_complexity: 100,
      priority: 100,
      enabled: true,
    });
  });

  it("URL 하위 경로와 쿼리에서 탭과 필터를 복원해 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    render("/routing/rules/health?window=7d&threshold=50");

    expect(await screen.findByRole("tab", { name: "상태·차단기", selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("조회 기간")).toHaveValue("7d");
    expect(screen.getByLabelText("저하 판단 점수")).toHaveValue(50);
    await waitFor(() =>
      expect(api.calls.find((call) => call.key === "GET /admin/routing/health")?.options.query).toEqual({
        window: "7d",
        threshold: 50,
      }),
    );
  });

  it("회로 차단기를 해제하면 공급자 이름을 본문으로 보낸다", async () => {
    const api = mockAllEndpoints();
    render("/routing/rules/health");

    await userEvent.click(await screen.findByRole("button", { name: "openai 회로 차단기 해제" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "해제" }));

    await waitFor(() => expect(api.bodies("POST /admin/routing/breaker-reset")).toHaveLength(1));
    expect(api.bodies("POST /admin/routing/breaker-reset")[0]).toEqual({ provider: "openai" });
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("회로 차단기를 해제했습니다."));
  });

  it("결정 이력에서 재작성된 요청과 상세를 보여준다", async () => {
    mockAllEndpoints({
      "GET /admin/routing/decisions/rd_1": () => ({ decision: decisionsResponse.decisions[0] }),
    });
    render("/routing/rules/decisions");

    const row = await screen.findByRole("row", { name: /gpt-4.1-mini/u });
    expect(within(row).getByText("재작성")).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: /결정 상세 보기/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("req_abc")).toBeInTheDocument();
    expect(within(dialog).getByText("timeout:openai->azure")).toBeInTheDocument();
  });

  it("장애 전환 커버리지에서 대체 공급자가 없는 곳을 표시한다", async () => {
    mockAllEndpoints();
    render("/routing/rules/failover");

    const row = await screen.findByRole("row", { name: /local/u });
    expect(within(row).getByText("대체 없음")).toBeInTheDocument();
  });

  it("학습 추천을 규칙으로 적용하면 복잡도 구간을 채워 보낸다", async () => {
    const api = mockAllEndpoints();
    render("/routing/rules/learning");

    await userEvent.click(await screen.findByRole("button", { name: /추천을 규칙으로 적용/u }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "규칙 만들기" }));

    await waitFor(() => expect(api.bodies("POST /admin/routing-rules")).toHaveLength(1));
    expect(api.bodies("POST /admin/routing-rules")[0]).toMatchObject({
      target_model: "gpt-4.1-mini",
      min_complexity: 0,
      max_complexity: 34,
      match_pattern: "*",
    });
  });

  it("검토 큐 승인은 승인 경로로 호출한다", async () => {
    const api = mockAllEndpoints();
    render("/routing/rules/learning");

    await userEvent.click(await screen.findByRole("button", { name: /검토 승인/u }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "승인" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/routing/domain-review/rv_1%2Fapprove")).toBe(
        true,
      ),
    );
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByRole("table", { name: "복잡도 기반 라우팅 규칙 목록" });
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("상태 탭도 접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render("/routing/rules/health");

    await screen.findByRole("button", { name: "openai 회로 차단기 해제" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
