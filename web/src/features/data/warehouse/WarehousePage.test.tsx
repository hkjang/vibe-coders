import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WarehousePage } from "@/features/data/warehouse/WarehousePage";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const overviewResponse = {
  configured: true,
  since: "2026-08-08",
  requests: 12_400,
  tokens: 8_100_000,
  cost_krw: 318_000,
  errors: 124,
  error_rate: 0.01,
  cost_per_request_krw: 25.6,
  cost_per_1k_tokens_krw: 39.2,
};

const timeseriesResponse = {
  configured: true,
  since: "2026-08-08",
  bucket: "day",
  points: [
    { day: "2026-09-05", requests: 400, tokens: 260_000, cost_krw: 10_200, errors: 4 },
    { day: "2026-09-06", requests: 512, tokens: 331_000, cost_krw: 13_050, errors: 7 },
  ],
};

const dimensionsResponse = {
  configured: true,
  since: "2026-08-08",
  dimension: "model",
  order_by: "cost_krw",
  rows: [
    {
      value: "gpt-4o-mini",
      requests: 8_100,
      tokens: 5_200_000,
      cost_krw: 210_000,
      errors: 41,
      error_rate: 0.005,
    },
  ],
};

const latencyResponse = {
  configured: true,
  since: "2026-08-08",
  total: 12_400,
  p50_ms: 820,
  p95_ms: 2_400,
  p99_ms: 5_100,
  avg_ms: 1_010,
  max_ms: 9_900,
  ttfb_p95_ms: 640,
  streamed: 9_100,
  stream_share: 0.73,
  errors: 124,
  error_rate: 0.01,
  by_model: [{ model: "gpt-4o-mini", requests: 8_100, p95_ms: 2_100, errors: 41, error_rate: 0.005 }],
};

const qualityResponse = {
  configured: true,
  since: "2026-08-08",
  eval: {
    configured: true,
    total: 320,
    avg_score: 0.82,
    pass_rate: 0.91,
    by_category: [{ category: "accuracy", count: 180, avg_score: 0.86, pass_rate: 0.94 }],
  },
  feedback: {
    configured: true,
    total: 74,
    avg_rating: 0.6,
    positive: 55,
    negative: 19,
    positive_rate: 0.74,
    by_label: [{ label: "helpful", count: 40 }],
  },
};

const routingResponse = {
  configured: true,
  since: "2026-08-08",
  total: 12_400,
  auto_routed: 3_100,
  auto_route_rate: 0.25,
  fallback_used: 42,
  avg_complexity: 0.4,
  avg_risk: 0.12,
  avg_health: 0.95,
  reasons: [{ reason: "cost_saving", count: 1_900 }],
  rewrites: [{ from: "gpt-4o", to: "gpt-4o-mini", count: 1_400 }],
};

const text2sqlResponse = {
  configured: true,
  since: "2026-08-08",
  total: 640,
  valid: 610,
  executed: 540,
  blocked: 30,
  block_rate: 0.047,
  avg_explain_risk: 0.21,
  cost_krw: 12_000,
  by_mode: [{ mode: "readonly", count: 600, executed: 520 }],
  failures: [{ reason: "schema_missing", count: 12 }],
};

const clickhouseOverviewResponse = {
  configured: true,
  database: "ai",
  table: "daily_rollups",
  sink: { interval: "10m0s", days: 3, auto_enabled: true },
  fact_table: { configured: true, name: "ai_text2sql_fact", exists: true },
  request_fact: {
    configured: true,
    table: "ai_request_fact",
    queue_depth: 12,
    queue_cap: 2_000,
    dropped: 0,
    batch_size: 500,
    flush: "5s",
    retry_batches: 1,
  },
  ping: { ok: true, latency_ms: 18 },
  rollup_table: {
    exists: true,
    engine: "ReplacingMergeTree",
    sorting_key: "day, dimension, dim_value",
    replacing_merge_tree: true,
    dedupe_ok: true,
  },
  watermarks: [],
  retries: [],
  retry_count: 0,
};

const sinkStatusResponse = {
  configured: true,
  state: [
    {
      dimension: "all",
      last_synced_day: "2026-09-06",
      last_success_at: "2026-09-07T01:00:00Z",
      rows_sent: 900,
      updated_at: "2026-09-07T01:00:00Z",
    },
  ],
  retries: [
    {
      dimension: "project",
      since_day: "2026-09-01",
      error: "connection refused",
      attempts: 3,
      first_failed_at: "2026-09-05T01:00:00Z",
      last_attempt_at: "2026-09-07T01:00:00Z",
    },
  ],
};

const lagResponse = {
  tables: [{ key: "request_fact", table: "ai_request_fact", rows: 120_000, exists: true }],
  local_requests: 130_000,
  queue_depth: 12,
  queue_cap: 2_000,
  dropped: 0,
  request_fact_rows: 120_000,
  request_fact_lag: 10_000,
  retry_batches: 1,
};

const consistencyResponse = {
  since: "2026-08-08",
  consistent: false,
  dimensions: [
    {
      dimension: "all",
      consistent: false,
      postgres: { requests: 130_000, tokens: 8_100_000, cost_krw: 318_000 },
      clickhouse: { requests: 120_000, tokens: 8_000_000, cost_krw: 310_000 },
      diff: { requests: 10_000, tokens: 100_000, cost_krw: 8_000 },
    },
  ],
};

const metricsResponse = {
  metrics: [
    {
      id: "metric_1",
      metric_key: "daily_cost",
      name_ko: "일별 비용",
      description: "일자별 총 비용",
      query_template: "SELECT toDate(ts) AS day, sum(cost_krw) FROM ai_request_fact GROUP BY day",
      dimensions: ["model", "team"],
      owner: "platform",
      sensitivity: "internal",
      enabled: true,
      version: 2,
      updated_by: "operator@example.com",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-09-06T02:00:00Z",
    },
  ],
};

function mockAllEndpoints(overrides: Readonly<Record<string, ApiHandler>> = {}) {
  return mockApi({
    "GET /admin/dw/dashboard/overview": () => overviewResponse,
    "GET /admin/dw/dashboard/timeseries": () => timeseriesResponse,
    "GET /admin/dw/dashboard/dimensions": () => dimensionsResponse,
    "GET /admin/dw/dashboard/latency": () => latencyResponse,
    "GET /admin/dw/dashboard/quality": () => qualityResponse,
    "GET /admin/dw/dashboard/routing": () => routingResponse,
    "GET /admin/dw/dashboard/text2sql": () => text2sqlResponse,
    "POST /admin/dw/dashboard/refresh": () => ({ status: "refreshed", cleared: 4 }),
    "GET /admin/dw/clickhouse/overview": () => clickhouseOverviewResponse,
    "GET /admin/dw/clickhouse/lag": () => lagResponse,
    "GET /admin/dw/sink-status": () => sinkStatusResponse,
    "GET /admin/dw/consistency": () => consistencyResponse,
    "POST /admin/dw/clickhouse": () => ({ sent_rows: 900, since: "2026-08-31" }),
    "POST /admin/dw/sink-retry": () => ({ recovered_dimensions: 1, sent_rows: 120, failed: {} }),
    "GET /admin/dw/metrics": () => metricsResponse,
    "POST /admin/dw/metrics": () => ({
      metric: metricsResponse.metrics[0],
      validation: { ok: true, errors: [], warnings: [], referenced_tables: ["ai_request_fact"] },
    }),
    "POST /admin/dw/metrics/metric_1/validate": () => ({
      metric_key: "daily_cost",
      validation: {
        ok: false,
        errors: ["민감 컬럼/원문 참조: prompt_text"],
        warnings: [],
        referenced_tables: ["ai_request_fact"],
        sensitive_refs: ["prompt_text"],
      },
    }),
    "DELETE /admin/dw/metrics/metric_1": () => ({ status: "deleted" }),
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

function render(route = "/data/warehouse") {
  return renderScreen(<WarehousePage />, { route, path: "/data/warehouse" });
}

describe("WarehousePage", () => {
  it("DW 핵심 지표와 차원별 Top 표를 보여준다", async () => {
    mockAllEndpoints();
    render();

    await screen.findByText("₩210,000");
    const kpis = screen.getByRole("region", { name: "DW 핵심 지표" });
    expect(within(kpis).getByText("12,400")).toBeInTheDocument();
    expect(within(kpis).getByText("₩318,000")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "모델별 사용량과 비용" });
    expect(within(table).getAllByText("gpt-4o-mini").length).toBeGreaterThan(0);
  });

  it("분석 저장소가 연결되지 않으면 빈 상태로 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/dw/dashboard/overview": () => ({ configured: false }) });
    render();

    expect(
      await screen.findByText("분석 저장소(ClickHouse)가 아직 연결되지 않았습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "모델별 사용량과 비용" })).not.toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/dw/dashboard/overview": () => {
        throw apiFailure("dw query failed", 502, "req_dw_1");
      },
    });
    render();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("DW 요약을(를) 불러오지 못했습니다.");
    expect(alert).toHaveTextContent("요청 ID: req_dw_1");
  });

  it("쓰기 권한이 없으면 변경 작업 버튼을 비활성화하고 사유를 표시한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockAllEndpoints();
    render("/data/warehouse?tab=pipeline");

    const cacheButton = await screen.findByRole("button", { name: /분석 캐시 비우기/u });
    expect(cacheButton).toBeDisabled();
    expect(cacheButton).toHaveAttribute("title", expect.stringContaining("admin:write"));

    const sinkButton = await screen.findByRole("button", { name: /지금 적재/u });
    expect(sinkButton).toBeDisabled();
    expect(screen.getByText("읽기 전용으로 열려 있습니다.")).toBeInTheDocument();
  });

  it("지금 적재를 확인하면 적재 API를 호출하고 결과를 알린다", async () => {
    const api = mockAllEndpoints();
    render("/data/warehouse?tab=pipeline");

    await userEvent.click(await screen.findByRole("button", { name: /지금 적재/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/최근 7일 롤업을 다시 계산해/u)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "적재" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/dw/clickhouse")).toBe(true),
    );
    expect(api.calls.find((call) => call.key === "POST /admin/dw/clickhouse")?.options.query).toEqual({
      days: 7,
    });
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("900행을 적재했습니다."));
  });

  it("URL 쿼리에서 조회 조건을 복원해 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    render("/data/warehouse?window=7d&dimension=provider&order_by=requests&bucket=week");

    await screen.findByText("₩210,000");
    expect(screen.getByRole("table", { name: "공급자별 사용량과 비용" })).toBeInTheDocument();
    expect(screen.getByLabelText("조회 구간")).toHaveValue("7d");
    expect(screen.getByLabelText("분석 차원")).toHaveValue("provider");
    expect(
      api.calls.find((call) => call.key === "GET /admin/dw/dashboard/dimensions")?.options.query,
    ).toEqual({ window: "7d", dimension: "provider", order_by: "requests", limit: 10 });
    expect(
      api.calls.find((call) => call.key === "GET /admin/dw/dashboard/timeseries")?.options.query,
    ).toEqual({ window: "7d", bucket: "week" });
  });

  it("지표 카탈로그 탭에서 등록된 지표를 보여준다", async () => {
    mockAllEndpoints();
    render("/data/warehouse?tab=metrics");

    expect(await screen.findByRole("tab", { name: "지표 카탈로그", selected: true })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "등록된 지표 목록" });
    expect(await within(table).findByRole("button", { name: "daily_cost" })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "daily_cost 쿼리 재검증" })).toBeEnabled();
    expect(within(table).getByRole("button", { name: "daily_cost 삭제" })).toBeEnabled();
  });

  it("지표 재검증이 지표 id 경로를 호출하고 검증 결과를 보여준다", async () => {
    const api = mockAllEndpoints();
    render("/data/warehouse?tab=metrics");

    await userEvent.click(await screen.findByRole("button", { name: "daily_cost 쿼리 재검증" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "POST /admin/dw/metrics/metric_1/validate")).toBe(true),
    );
    expect(await screen.findByText(/민감 컬럼\/원문 참조/u)).toBeInTheDocument();
    expect(toastSpy.success).toHaveBeenCalledWith("지표 daily_cost의 쿼리를 재검증했습니다.");
  });

  it("지표 삭제는 확인 다이얼로그를 거쳐 DELETE 를 호출한다", async () => {
    const api = mockAllEndpoints();
    render("/data/warehouse?tab=metrics");

    await userEvent.click(await screen.findByRole("button", { name: "daily_cost 삭제" }));

    const dialog = await screen.findByRole("dialog", { name: "지표 정의를 삭제할까요?" });
    expect(api.calls.some((call) => call.key === "DELETE /admin/dw/metrics/metric_1")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "DELETE /admin/dw/metrics/metric_1")).toBe(true),
    );
    expect(toastSpy.success).toHaveBeenCalledWith("지표 daily_cost을(를) 삭제했습니다.");
  });

  it("쓰기 권한이 없으면 지표 재검증과 삭제 버튼이 비활성화된다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockAllEndpoints();
    render("/data/warehouse?tab=metrics");

    expect(await screen.findByRole("button", { name: "daily_cost 쿼리 재검증" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "daily_cost 삭제" })).toBeDisabled();
  });

  it("CSV 내보내기가 서버 내보내기를 인증 헤더와 함께 호출한다", async () => {
    mockAllEndpoints();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("day,requests\n", { status: 200 }));
    render("/data/warehouse?window=7d");

    await screen.findByText("₩210,000");
    await userEvent.click(screen.getByRole("button", { name: /CSV 내보내기/u }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/admin/dw/dashboard/export.csv?window=7d&dimension=model&order_by=cost&limit=100");
    expect(new Headers(init.headers).get("X-Vibe-UI")).toBe("app");
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByText("₩210,000");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
