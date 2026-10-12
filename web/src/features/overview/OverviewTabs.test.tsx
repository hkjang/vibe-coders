import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OverviewPage } from "@/features/overview/OverviewPage";
import { usePreferences } from "@/shared/stores/preferences";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    backendVersion: "v0.84.0",
    legacyFallback: true,
    mode: "authenticated",
    user: { scopes: ["admin:read", "routing:read"] },
  }),
}));

const stats = {
  total_requests: 120,
  total_tokens: 30_000,
  total_cost_krw: 4_200,
  average_latency_ms: 125.2,
  by_ip: [{ key: "192.0.2.10", requests: 40, tokens: 9_000, cost_krw: 900, average_latency_ms: 110 }],
  by_model: [{ key: "gpt-test", requests: 100, tokens: 28_000, cost_krw: 3_800, average_latency_ms: 130 }],
  by_language: [{ language: "typescript", requests: 60, average_confidence: 0.92 }],
  by_status: [
    { class: "2xx", requests: 110 },
    { class: "5xx", requests: 10 },
  ],
  top_users: [
    {
      api_key_id: "key-1",
      name: "플랫폼 팀 키",
      owner: "platform",
      team: "platform",
      status: "active",
      requests: 90,
      tokens: 22_000,
      cost_krw: 3_000,
      average_latency_ms: 120,
      last_seen: "2026-09-06T02:00:00Z",
    },
  ],
  latency_quantiles: { p50: 100, p95: 250, p99: 400 },
  first_chunk_quantiles: { p50: 20, p95: 50, p99: 80 },
  cache: { entries: 1, bytes: 256, total_hits: 3, top_models: [] },
  failover_total: 2,
  cache_hits: 3,
  cache_misses: 1,
};

const opsRisk = {
  risk: { score: 10, tier: "low", factors: [] },
  status: {
    generated_at: "2026-09-06T02:00:00Z",
    providers: [],
    logging: { queue_depth: 0, written: 100, dropped: 0 },
    fallback: {
      path: "/data/fallback.ndjson",
      exists: true,
      lines: 4,
      bytes: 2_048,
      modified_at: "2026-09-06T01:00:00Z",
    },
    security: {
      auth_enabled: true,
      dev_secret: false,
      raw_prompts_logged: false,
      raw_bodies_logged: false,
      pricing_configured: true,
    },
    disk: { path: "/data", available: true, free_bytes: 1_000_000, total_bytes: 2_000_000, used_percent: 50 },
  },
};

const routing = {
  since: "2026-09-06T01:00:00Z",
  until: "2026-09-06T02:00:00Z",
  threshold: 70,
  providers: [],
  ranking: [],
  degraded: [],
  alerts: [],
  trend: [],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    states: [],
    shared: false,
    instance_id: "gateway-1",
  },
};

const capabilities = {
  capabilities: [
    {
      key: "chat_proxy",
      name: "Chat 프록시",
      description: "OpenAI 호환 채팅 중계와 사용량 추적.",
      group: "core",
      apis: ["POST /v1/chat/completions"],
      ui_tabs: ["requests", "llm"],
      scopes: ["admin:read"],
      setting_keys: [],
      tables: ["request_logs"],
      workers: ["async_logger"],
      docs: [],
    },
  ],
  count: 1,
  groups: { core: 1 },
  note: "코드 정의 레지스트리입니다.",
};

const baseHandlers = {
  "GET /health": () => ({ status: "ok" }),
  "GET /admin/stats": () => stats,
  "GET /admin/routing/health": () => routing,
  "GET /admin/ops/risk": () => opsRisk,
};

function renderPage(route = "/overview"): ReturnType<typeof renderScreen> {
  return renderScreen(<OverviewPage />, { path: "/overview", route });
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error("응답 준비 전입니다.");
  };
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("OverviewPage tabs", () => {
  beforeEach(() => {
    usePreferences.setState({ refreshInterval: 0 });
  });

  it("keeps the operations widgets on the default tab", async () => {
    mockApi(baseHandlers);
    renderPage();

    expect(await screen.findByRole("region", { name: "운영 영역 요약" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "운영 상태", selected: true })).toBeVisible();
  });

  it("restores the usage tab from the URL with the breakdowns the legacy dashboard showed", async () => {
    mockApi(baseHandlers);
    renderPage("/overview?tab=usage");

    const models = await screen.findByRole("table", { name: "모델별 요청과 비용" });
    expect(within(models).getByText("gpt-test")).toBeVisible();
    const users = screen.getByRole("table", { name: "요청량 상위 API 키" });
    expect(within(users).getByText("플랫폼 팀 키")).toBeVisible();
    const status = screen.getByRole("table", { name: "응답 상태별 요청 수" });
    expect(within(status).getByText("서버 오류 (5xx)")).toBeVisible();
    expect(screen.getByRole("table", { name: "언어별 요청 수" })).toBeVisible();
  });

  it("renders the capability map and filters it", async () => {
    const user = userEvent.setup();
    mockApi({ ...baseHandlers, "GET /admin/capabilities": () => capabilities });
    renderPage();

    await user.click(await screen.findByRole("tab", { name: "기능 맵" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Chat 프록시" })).toBeVisible();
    await user.type(screen.getByLabelText("기능 검색"), "존재하지않는기능");
    expect(await screen.findByText("검색 결과가 없습니다.")).toBeVisible();
  });

  it("전체 새로고침은 현재 사용 현황의 추이와 활동 분포도 갱신한다", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    await screen.findByRole("heading", { name: "사용 추이" });
    const count = (path: string): number => api.calls.filter((call) => call.key === `GET ${path}`).length;
    await waitFor(() => expect(count("/admin/heatmap")).toBe(1));
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    await waitFor(() => {
      expect(count("/admin/timeseries")).toBe(2);
      expect(count("/admin/heatmap")).toBe(2);
    });
  });

  it("요약의 새 응답을 게이트웨이 응답 시각으로 표시하지 않는다", async () => {
    mockApi(baseHandlers);
    const { client } = renderPage();
    await screen.findByText("₩4,200");
    const healthAt = Date.parse("2026-10-12T01:00:00Z");
    act(() => {
      client.setQueryData(["gateway", "health"], { status: "ok" }, { updatedAt: healthAt });
      client.setQueryData(["admin", "stats"], stats, { updatedAt: healthAt + 60_000 });
    });
    const timestamp = await screen.findByText(/게이트웨이 응답/);
    expect(timestamp).toHaveAttribute("datetime", new Date(healthAt).toISOString());
  });

  it("이전 기간의 늦은 추이 응답은 새 기간의 차트를 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const old = deferred<{ points: { date: string; requests: number; cost_krw: number }[] }>();
    mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": (options) =>
        (options.query as { window: string }).window === "7d"
          ? old.promise
          : { points: [{ date: "2026-10-12", requests: 30, cost_krw: 300 }] },
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    await screen.findByText("추이를 불러오는 중입니다.");
    await user.click(screen.getByRole("button", { name: "최근 30일" }));
    await screen.findByRole("img", { name: "최근 30일 요청 수" });
    await act(async () => {
      old.resolve({ points: [{ date: "2026-10-01", requests: 7, cost_krw: 70 }] });
    });
    expect(screen.getByRole("img", { name: "최근 30일 요청 수" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "최근 7일 요청 수" })).not.toBeInTheDocument();
    expect(screen.queryByText("2026-10-01")).not.toBeInTheDocument();
  });

  it("추이 갱신이 진행 중이면 전체 새로고침의 중복 실행을 막는다", async () => {
    const user = userEvent.setup();
    const next = deferred<{ points: [] }>();
    let count = 0;
    mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => (++count === 1 ? { points: [] } : next.promise),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    const refresh = screen.getByRole("button", { name: "전체 새로고침" });
    await waitFor(() => expect(refresh).toBeEnabled());
    await user.click(refresh);
    expect(refresh).toBeDisabled();
    await user.click(refresh);
    expect(count).toBe(2);
    await act(async () => {
      next.resolve({ points: [] });
    });
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it("사용 현황 조회 권한이 거부되면 이전 누적 내역을 숨긴다", async () => {
    const user = userEvent.setup();
    let denied = false;
    mockApi({
      ...baseHandlers,
      "GET /admin/stats": () => {
        if (denied) throw apiFailure("denied", 403);
        return stats;
      },
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    await screen.findByRole("table", { name: "모델별 요청과 비용" });
    denied = true;
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    await waitFor(() =>
      expect(screen.queryByRole("table", { name: "모델별 요청과 비용" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("gpt-test")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "누적 사용량 다시 시도" })).toBeVisible();
  });

  it("누적 통계가 실패해도 독립적인 사용 추이는 표시한다", async () => {
    const user = userEvent.setup();
    let failed = true;
    mockApi({
      ...baseHandlers,
      "GET /admin/stats": () => {
        if (failed) throw apiFailure("stats unavailable", 503, "req_stats_partial");
        return stats;
      },
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    expect(await screen.findByRole("heading", { name: "사용 추이" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "요일·시간대 활동" })).toBeVisible();
    expect(await screen.findByText("요청 ID: req_stats_partial")).toBeVisible();
    failed = false;
    await user.click(screen.getByRole("button", { name: "누적 사용량 다시 시도" }));
    expect(await screen.findByRole("table", { name: "응답 상태별 요청 수" })).toBeVisible();
  });

  it("추이 오류는 요청 ID와 독립적인 재시도를 제공한다", async () => {
    const user = userEvent.setup();
    let failed = true;
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => {
        if (failed) throw apiFailure("trend unavailable", 503, "req_trend_partial");
        return { points: [] };
      },
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    expect(await screen.findByText("요청 ID: req_trend_partial")).toBeVisible();
    failed = false;
    await user.click(screen.getByRole("button", { name: "사용 추이 다시 시도" }));
    await waitFor(() => expect(api.calls.filter((c) => c.key === "GET /admin/timeseries")).toHaveLength(2));
    expect(api.calls.filter((c) => c.key === "GET /admin/heatmap")).toHaveLength(1);
  });

  it("일시 오류는 마지막 추이를 유지하지만 권한 거부 뒤에는 숨긴다", async () => {
    const user = userEvent.setup();
    let failure: number | undefined;
    mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => {
        if (failure) throw apiFailure("trend unavailable", failure, "req_trend_retained");
        return { points: [{ date: "2026-10-12", requests: 17, cost_krw: 150 }] };
      },
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage");
    expect(await screen.findByRole("img", { name: "최근 7일 요청 수" })).toBeVisible();
    failure = 503;
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    expect(await screen.findByText("요청 ID: req_trend_retained")).toBeVisible();
    expect(screen.getByRole("img", { name: "최근 7일 요청 수" })).toBeVisible();
    expect(screen.getByText("마지막 정상 데이터를 표시합니다. 현재 상태와 다를 수 있습니다.")).toBeVisible();
    failure = 403;
    await user.click(screen.getByRole("button", { name: "사용 추이 다시 시도" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "최근 7일 요청 수" })).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText("마지막 정상 데이터를 표시합니다. 현재 상태와 다를 수 있습니다."),
    ).not.toBeInTheDocument();
  });

  it("같은 응답을 사용하는 운영 보조 카드도 갱신 실패를 표시한다", async () => {
    const user = userEvent.setup();
    let failed = false;
    mockApi({
      ...baseHandlers,
      "GET /admin/stats": () => {
        if (failed) throw apiFailure("stats unavailable");
        return stats;
      },
      "GET /admin/ops/risk": () => {
        if (failed) throw apiFailure("ops unavailable");
        return opsRisk;
      },
    });
    renderPage();
    await screen.findByRole("heading", { name: "프로세스 런타임" });
    failed = true;
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    await waitFor(() => {
      for (const name of ["프로세스 런타임", "운영 기반"]) {
        const card = screen.getByRole("heading", { name }).closest("article");
        expect(card).not.toBeNull();
        if (!card) throw new Error("운영 보조 카드를 찾을 수 없습니다.");
        expect(within(card).getByText("새 갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
      }
    });
  });

  it("운영 상태 조회 권한이 거부되면 이전 비용과 운영 데이터를 숨긴다", async () => {
    const user = userEvent.setup();
    let denied = false;
    mockApi({
      ...baseHandlers,
      "GET /admin/stats": () => {
        if (denied) throw apiFailure("denied", 403);
        return stats;
      },
      "GET /admin/ops/risk": () => {
        if (denied) throw apiFailure("denied", 403);
        return opsRisk;
      },
    });
    renderPage();
    await screen.findByText("₩4,200");
    denied = true;
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    await waitFor(() => expect(screen.queryByText("₩4,200")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "프로세스 런타임" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "운영 기반" })).not.toBeInTheDocument();
  });

  it("현재 기능 맵만 갱신하고 닫힌 사용 현황 조회는 재실행하지 않는다", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
      "GET /admin/capabilities": () => capabilities,
    });
    renderPage("/overview?tab=usage");
    await screen.findByRole("heading", { name: "사용 추이" });
    await waitFor(() => expect(api.calls.filter((c) => c.key === "GET /admin/heatmap")).toHaveLength(1));
    await user.click(screen.getByRole("tab", { name: "기능 맵" }));
    await screen.findByRole("heading", { name: "Chat 프록시" });
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));
    await waitFor(() => expect(api.calls.filter((c) => c.key === "GET /admin/capabilities")).toHaveLength(2));
    expect(api.calls.filter((c) => c.key === "GET /admin/timeseries")).toHaveLength(1);
    expect(api.calls.filter((c) => c.key === "GET /admin/heatmap")).toHaveLength(1);
  });

  it("추이 기간을 주소에서 복원하고 탭을 다시 열어도 유지한다", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    renderPage("/overview?tab=usage&trend=30d");
    const picker = await screen.findByRole("group", { name: "추이 기간" });
    expect(within(picker).getByRole("button", { name: "최근 30일", pressed: true })).toBeVisible();
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.key === "GET /admin/timeseries" && (c.options.query as { window?: string }).window === "30d",
        ),
      ).toBe(true),
    );
    await user.click(within(picker).getByRole("button", { name: "최근 24시간" }));
    await user.click(screen.getByRole("tab", { name: "운영 상태" }));
    await user.click(screen.getByRole("tab", { name: "사용 현황" }));
    expect(
      within(await screen.findByRole("group", { name: "추이 기간" })).getByRole("button", {
        name: "최근 24시간",
        pressed: true,
      }),
    ).toBeVisible();
  });

  it("사용 추이도 자동 갱신하며 비활성 브라우저에서는 조회를 멈춘다", async () => {
    vi.useFakeTimers();
    usePreferences.setState({ refreshInterval: 60 });
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/timeseries": () => ({ points: [] }),
      "GET /admin/heatmap": () => ({ cells: [] }),
    });
    const view = renderPage("/overview?tab=usage");
    const count = (path: string): number => api.calls.filter((call) => call.key === `GET ${path}`).length;
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(count("/admin/timeseries")).toBe(1);
      expect(count("/admin/heatmap")).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(count("/admin/timeseries")).toBe(2);
      expect(count("/admin/heatmap")).toBe(2);
      act(() => focusManager.setFocused(false));
      const beforeHidden = api.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(api.calls).toHaveLength(beforeHidden);
    } finally {
      view.unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it("shows the request id when the capability map fails", async () => {
    const user = userEvent.setup();
    mockApi({
      ...baseHandlers,
      "GET /admin/capabilities": () => {
        throw apiFailure("capabilities unavailable", 500, "req_cap_1");
      },
    });
    renderPage();

    await user.click(await screen.findByRole("tab", { name: "기능 맵" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_cap_1");
  });

  it("has no automated accessibility violations on the capability tab", async () => {
    const user = userEvent.setup();
    mockApi({ ...baseHandlers, "GET /admin/capabilities": () => capabilities });
    const { container } = renderPage();

    await user.click(await screen.findByRole("tab", { name: "기능 맵" }));
    await screen.findByRole("heading", { level: 3, name: "Chat 프록시" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
