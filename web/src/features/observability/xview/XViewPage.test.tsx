import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { XViewPage } from "@/features/observability/xview/XViewPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

function point(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "req-1",
    trace_id: "trace-1",
    created_at: "2026-09-06T01:00:00Z",
    ingested_at: "2026-09-06T01:00:01Z",
    latency_ms: 900,
    first_chunk_ms: 200,
    status_code: 200,
    provider: "openai",
    model: "gpt-test",
    endpoint: "/v1/chat/completions",
    total_tokens: 1200,
    cost_krw: 90,
    stream: true,
    tool_count: 0,
    failover: false,
    complexity: 30,
    risk_score: 5,
    health_score: 90,
    decision_reason: "",
    policy_decision_count: 0,
    policy_decision: "",
    approval_count: 0,
    approval_status: "",
    secret_event_count: 0,
    secret_action: "",
    ...overrides,
  };
}

const scatterResponse = {
  points: [point(), point({ request_id: "req-2", status_code: 500, latency_ms: 4200 })],
  groups: [],
  truncated: false,
  since: "2026-09-06T00:00:00Z",
  cursor: { ingested_at: "2026-09-06T01:00:01Z", request_id: "req-2" },
  server_time: "2026-09-06T01:00:05Z",
};

const emptyDelta = {
  points: [],
  cursor: { ingested_at: "2026-09-06T01:00:01Z", request_id: "req-2" },
  has_more: false,
  server_time: "2026-09-06T01:00:05Z",
};

const savedFilters = {
  filters: [
    {
      id: "filt_1",
      name: "느린 호출",
      view: "xview",
      params: "window=6h&metric=latency&scale=log",
      created_by: "admin",
      created_at: "2026-09-01T00:00:00Z",
    },
  ],
};

const modelsResponse = {
  since: "2026-09-06T00:00:00Z",
  top: 10,
  models: [
    {
      model: "gpt-test",
      count: 120,
      error_rate: 0.05,
      p50: 800,
      p95: 2400,
      p99: 4200,
      avg_first_chunk_ms: 210,
      total_tokens: 24000,
      total_cost_krw: 1800,
      avg_cost_krw: 15,
      failover_count: 2,
      governance_count: 1,
      risk_p95: 12,
      health_avg: 88,
    },
  ],
  truncated: true,
  sample_size: 5000,
  aggregate_limit: 5000,
  covered_since: "2026-09-06T00:30:00Z",
};

const seriesResponse = {
  since: "2026-09-06T00:00:00Z",
  bucket: "hour",
  series: {
    "gpt-test": [
      { ts: "2026-09-06T00:00:00Z", count: 40, error_rate: 0.02, avg_latency_ms: 800, cost_krw: 300 },
      { ts: "2026-09-06T01:00:00Z", count: 80, error_rate: 0.05, avg_latency_ms: 900, cost_krw: 500 },
    ],
  },
  truncated: false,
  sample_size: 120,
  aggregate_limit: 5000,
};

const outliersResponse = {
  since: "2026-09-06T00:00:00Z",
  outliers: [
    { request_id: "req-2", trace_id: "trace-2", model: "gpt-test", latency_ms: 4200, tags: ["error_5xx"] },
  ],
  truncated: false,
  sample_size: 120,
  aggregate_limit: 5000,
};

const scatterHandlers = {
  "GET /admin/scatter": () => scatterResponse,
  "GET /admin/xview/delta": () => emptyDelta,
  "GET /admin/saved-filters": () => savedFilters,
};

function renderPage(route = "/observability/xview"): ReturnType<typeof renderScreen> {
  return renderScreen(<XViewPage />, { path: "/observability/xview", route });
}

describe("XViewPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the live scatter and the signal summary", async () => {
    mockApi(scatterHandlers);
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "XView 실시간" })).toBeVisible();
    expect(await screen.findByRole("img", { name: /산점도/u })).toBeVisible();
    const signals = await screen.findByRole("region", { name: "지금 확인할 신호" });
    await waitFor(() => {
      expect(within(signals).getByText("2")).toBeVisible();
    });
  });

  it("shows an empty state when the window has no request", async () => {
    mockApi({ ...scatterHandlers, "GET /admin/scatter": () => ({ ...scatterResponse, points: [] }) });
    renderPage();

    expect(await screen.findByText("표시할 요청이 없습니다.")).toBeVisible();
  });

  it("shows the request id when the snapshot fails", async () => {
    mockApi({
      ...scatterHandlers,
      "GET /admin/scatter": () => {
        throw apiFailure("scatter unavailable", 500, "req_xv_1");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_xv_1");
  });

  it("polls the delta feed every 1.5 seconds and merges new points", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi({
      ...scatterHandlers,
      "GET /admin/xview/delta": () => ({
        ...emptyDelta,
        points: [point({ request_id: "req-3", created_at: "2026-09-06T01:00:10Z" })],
        cursor: { ingested_at: "2026-09-06T01:00:11Z", request_id: "req-3" },
      }),
    });
    renderPage();

    await screen.findByRole("img", { name: /산점도/u });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });

    await waitFor(() => {
      expect(api.calls.filter((call) => call.key === "GET /admin/xview/delta")).not.toHaveLength(0);
    });
    const signals = await screen.findByRole("region", { name: "지금 확인할 신호" });
    await waitFor(() => {
      expect(within(signals).getByText("3")).toBeVisible();
    });
  });

  it("stops polling while the document is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi(scatterHandlers);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderPage();

    await screen.findByRole("img", { name: /산점도/u });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(api.calls.filter((call) => call.key === "GET /admin/xview/delta")).toHaveLength(0);
    expect(await screen.findByText("탭이 가려져 실시간 갱신을 멈췄습니다.")).toBeVisible();
    hidden.mockRestore();
  });

  it("keeps the last points and backs off when the delta feed fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi({
      ...scatterHandlers,
      "GET /admin/xview/delta": () => {
        throw apiFailure("delta unavailable", 503, "req_xv_2");
      },
    });
    renderPage();

    await screen.findByRole("img", { name: /산점도/u });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(await screen.findByText("실시간 갱신이 지연되고 있습니다.")).toBeVisible();

    const afterFirst = api.calls.filter((call) => call.key === "GET /admin/xview/delta").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    // The retry is scheduled at 3s (2^1 × 1.5s), so 1.6s later there is no new call.
    expect(api.calls.filter((call) => call.key === "GET /admin/xview/delta")).toHaveLength(afterFirst);
    expect(await screen.findByRole("img", { name: /산점도/u })).toBeVisible();
  });

  it("lists sessions on the waterfall tab and opens one", async () => {
    const user = userEvent.setup();
    mockApi({
      ...scatterHandlers,
      "GET /admin/llm/sessions": () => ({
        sessions: [
          {
            session_id: "sess-alpha",
            requests: 4,
            tokens: 1200,
            cost_krw: 90,
            errors: 1,
            evaluation_failures: 0,
            first_seen: "2026-09-06T01:00:00Z",
            last_seen: "2026-09-06T01:10:00Z",
            last_message: "리팩터링 도와줘",
          },
        ],
        page: { limit: 25, offset: 0, has_more: false },
      }),
      "GET /admin/llm/session": () => ({
        session_id: "sess-alpha",
        requests: 1,
        total_cost_krw: 90,
        total_tokens: 1200,
        tool_calls: 0,
        duration_seconds: 600,
        points: [
          {
            request_id: "req-1",
            trace_id: "trace-1",
            model: "gpt-test",
            provider: "openai",
            prompt_name: "",
            last_message: "",
            status_code: 200,
            latency_ms: 900,
            first_chunk_ms: 200,
            total_tokens: 1200,
            cost_krw: 90,
            tool_calls: 0,
            tool_errors: 0,
            eval_failures: 0,
            created_at: "2026-09-06T01:00:00Z",
            cumulative_cost_krw: 90,
            cumulative_tokens: 1200,
          },
        ],
      }),
      "GET /admin/waterfall": () => ({
        session_id: "sess-alpha",
        requests: 1,
        wall_ms: 2000,
        busy_ms: 900,
        idle_ms: 1100,
        busy_ratio: 0.45,
        total_cost_krw: 90,
        total_tokens: 1200,
        tool_calls: 0,
        wait_ms: 200,
        stream_ms: 700,
        slow_ms: 3000,
        slow_count: 0,
        bottleneck: {
          slowest_seq: 1,
          slowest_ms: 900,
          slowest_pct: 45,
          longest_gap_seq: 1,
          longest_gap_ms: 0,
          longest_gap_pct: 0,
        },
        categories: { normal: 1 },
        started_at: "2026-09-06T01:00:00Z",
        truncated: false,
        spans: [
          {
            seq: 1,
            request_id: "req-1",
            trace_id: "trace-1",
            model: "gpt-test",
            requested_model: "gpt-test",
            provider: "openai",
            endpoint: "/v1/chat/completions",
            status_code: 200,
            start_offset_ms: 0,
            ttfb_ms: 200,
            total_ms: 900,
            gap_before_ms: 0,
            category: "normal",
            complexity: 30,
            total_tokens: 1200,
            cost_krw: 90,
            tool_calls: 0,
            tool_errors: 0,
            fallback_from: "",
            slow: false,
            created_at: "2026-09-06T01:00:00Z",
          },
        ],
      }),
    });
    renderPage("/observability/xview?tab=waterfall");

    await user.click(await screen.findByRole("button", { name: "sess-alpha 워터폴 열기" }));

    expect(await screen.findByRole("table", { name: "세션 요청 워터폴" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "세션 누적 비용" })).toBeVisible();
  });

  it("shows the aggregate coverage disclosure on the model tab", async () => {
    mockApi({
      ...scatterHandlers,
      "GET /admin/xview/models": () => modelsResponse,
      "GET /admin/xview/model-series": () => seriesResponse,
      "GET /admin/xview/model-outliers": () => outliersResponse,
    });
    renderPage("/observability/xview?tab=models");

    expect(await screen.findByText(/모델별 요약: 표본이 잘렸습니다./u)).toBeVisible();
    expect(await screen.findByText(/상한 5,000건에 걸려 최근 5,000건만 집계했습니다./u)).toBeVisible();
    expect(await screen.findByText(/이전 트래픽은 이 수치에 포함되지 않습니다/u)).toBeVisible();
    expect(await screen.findByText(/모델별 추이: 표본 120건/u)).toBeVisible();
  });

  it("disables saved view management without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(scatterHandlers);
    renderPage();

    expect(await screen.findByRole("button", { name: /새로 저장/u })).toBeDisabled();
  });

  it("saves the current filters as a new view", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...scatterHandlers,
      "POST /admin/saved-filters": () => ({ filter: { ...savedFilters.filters[0], id: "filt_2" } }),
    });
    renderPage("/observability/xview?window=6h&metric=cost");

    await user.click(await screen.findByRole("button", { name: /새로 저장/u }));
    await user.type(await screen.findByLabelText(/뷰 이름/u), "비용 급증");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/saved-filters")).toEqual([
        {
          view: "xview",
          name: "비용 급증",
          params: "window=6h&metric=cost&scale=log&viewMode=category&tz=Asia%2FSeoul",
        },
      ]);
    });
  });

  it("opens the explanation sheet for a selected request", async () => {
    mockApi({
      ...scatterHandlers,
      "GET /admin/requests/req-1/explain": () => ({
        request_id: "req-1",
        trace_id: "trace-1",
        created_at: "2026-09-06T01:00:00Z",
        routing: {
          chosen_provider: "openai",
          chosen_model: "gpt-test",
          reason: "default",
          reason_text: "기본 provider",
          risk_categories: [],
          fallback_path: [],
        },
        fallback: { occurred: false },
        cache: { hit: false, cached_tokens: 0 },
        safety: { blocked: false, masking: "", finding_count: 0, findings: [] },
        governance: {
          secret_event_count: 0,
          secret_actions: {},
          approval_count: 0,
          approval_status: "",
          anomaly_event_count: 0,
          policy_decision_count: 0,
          policy_decision_total: 0,
        },
        text2sql: { span_count: 0, status: "none", total_latency_ms: 0, total_cost_krw: 0 },
        cost: {
          actual_krw: 90,
          currency: "KRW",
          token_source: "usage",
          prompt_tokens: 800,
          completion_tokens: 400,
          cached_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 1200,
          priced: false,
        },
        session: { session_id: "", stream: false },
      }),
      "GET /admin/requests/req-1/note": () => ({ request_id: "req-1", tags: [], note: "" }),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "최근 25건 선택" }));
    await user.click(await screen.findByRole("button", { name: "req-1 원인 설명 열기" }));

    const sheet = await screen.findByRole("dialog", { name: "요청 원인 설명" });
    expect(await within(sheet).findByText("기본 provider")).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    mockApi(scatterHandlers);
    const { container } = renderPage();

    await screen.findByRole("img", { name: /산점도/u });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
