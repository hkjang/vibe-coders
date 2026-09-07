import { screen, within } from "@testing-library/react";
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
