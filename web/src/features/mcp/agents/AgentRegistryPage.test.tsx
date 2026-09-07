import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRegistryPage } from "@/features/mcp/agents/AgentRegistryPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: toastSpy }));

const agentRoute = {
  id: "agr_1",
  virtual_model: "vibe/agent-research",
  name: "리서치 에이전트",
  enabled: true,
  backing_model: "gpt-4.1",
  provider: "openai",
  provider_ref: "",
  mcp_upstreams: ["github"],
  allowed_tools: ["github__create_issue"],
  system_prompt: "도구를 활용해 답변하세요.",
  max_steps: 6,
  max_cost_krw: 500,
  created_by: "admin",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

const routeList = { agent_routes: [agentRoute], count: 1, note: "가상 모델명을 호출하면 됩니다." };

const providerList = {
  providers: [
    {
      name: "openai",
      provider_ref: `prv_${"a".repeat(43)}`,
      base_url: "https://api.openai.example/v1",
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: true,
      model_patterns: "gpt-*",
      failover_group: "premium",
      priority: 10,
      created_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const upstreamList = {
  upstreams: [
    {
      id: "github",
      name: "GitHub MCP",
      url: "https://mcp.example.com/mcp",
      has_auth: false,
      enabled: true,
      created_at: "2026-09-01T00:00:00Z",
      metadata: {},
    },
  ],
  discovery_errors: {},
};

const baseHandlers = {
  "GET /admin/agent-routes": () => routeList,
  "GET /admin/providers": () => providerList,
  "GET /admin/mcp/upstreams": () => upstreamList,
  "GET /admin/agent-routes/tool-catalog": () => ({ tools: [], count: 0, errors: {} }),
};

function renderPage(route = "/agents/registry") {
  return renderScreen(<AgentRegistryPage />, { route, path: "/agents/registry/*" });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

describe("AgentRegistryPage", () => {
  it("에이전트 라우트를 보여 준다", async () => {
    mockApi(baseHandlers);
    renderPage();

    expect(await screen.findByText("vibe/agent-research")).toBeInTheDocument();
    expect(screen.getByText("리서치 에이전트")).toBeInTheDocument();
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
  });

  it("라우트가 없으면 빈 상태를 안내한다", async () => {
    mockApi({ ...baseHandlers, "GET /admin/agent-routes": () => ({ agent_routes: [], count: 0, note: "" }) });
    renderPage();

    expect(await screen.findByText("등록된 에이전트 라우트가 없습니다.")).toBeInTheDocument();
  });

  it("조회 실패 시 요청 ID를 포함한 오류를 알린다", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/agent-routes": () => {
        throw apiFailure("agent routes failed", 500, "req_agent_1");
      },
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/요청 ID: req_agent_1/)).toBeInTheDocument();
  });

  it("admin:write 권한이 없으면 쓰기 작업을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(baseHandlers);
    renderPage();

    expect(await screen.findByRole("button", { name: /라우트 생성/ })).toBeDisabled();
    await screen.findByText("vibe/agent-research");
    expect(screen.getByRole("button", { name: "삭제" })).toBeDisabled();
  });

  it("라우트를 중지하면 기존 설정에 enabled=false로 저장한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "POST /admin/agent-routes": () => ({ agent_route: { ...agentRoute, enabled: false } }),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "중지" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/agent-routes")).toHaveLength(1);
    });
    expect(api.bodies("POST /admin/agent-routes")[0]).toMatchObject({
      id: "agr_1",
      virtual_model: "vibe/agent-research",
      enabled: false,
      mcp_upstreams: ["github"],
    });
    await waitFor(() => {
      expect(toastSpy.success).toHaveBeenCalledWith("에이전트 라우트를 저장했습니다.");
    });
  });

  it("URL 쿼리로 VCS 탭과 필터를 복원한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/vcs/events": () => ({
        events: [
          {
            id: "vcs_1",
            provider: "gitlab",
            kind: "merge_request",
            repo: "team/service",
            branch: "feature/mcp",
            ref: "12",
            title: "MCP 라우트 추가",
            url: "https://git.example.com/mr/12",
            author_email: "dev@example.com",
            author_name: "개발자",
            state: "merged",
            session_id: "sess_1",
            api_key_id: "key_1",
            created_at: "2026-09-05T01:00:00Z",
          },
        ],
      }),
    });
    renderPage("/agents/registry?tab=vcs&repo=team%2Fservice");

    expect(await screen.findByRole("tab", { name: /VCS 이벤트/, selected: true })).toBeInTheDocument();
    expect(await screen.findByText("MCP 라우트 추가")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.calls.find((call) => call.key === "GET /admin/vcs/events")?.options.query).toMatchObject({
        repo: "team/service",
      });
    });
  });

  it("에이전트 성능 탭에서 기간별 지표를 조회한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/agents": () => ({
        since: "2026-09-05T00:00:00Z",
        agents: [
          {
            agent: "cursor",
            requests: 42,
            success_rate: 0.95,
            fallback_rate: 0.02,
            tokens: 12000,
            avg_cost_krw: 12,
            total_cost_krw: 504,
            avg_latency_ms: 820,
            avg_first_chunk_ms: 210,
            tool_calls: 12,
            tool_errors: 1,
            tool_error_rate: 0.08,
            last_seen: "2026-09-06T09:00:00Z",
          },
        ],
      }),
    });
    renderPage("/agents/registry?tab=performance");

    expect(await screen.findByText("cursor")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.calls.find((call) => call.key === "GET /admin/agents")?.options.query).toEqual({
        window: "24h",
      });
    });
  });

  it("접근성 위반이 없다", async () => {
    mockApi(baseHandlers);
    const { container } = renderPage();

    await screen.findByText("vibe/agent-research");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
