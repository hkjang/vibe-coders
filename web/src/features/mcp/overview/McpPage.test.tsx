import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpPage } from "@/features/mcp/overview/McpPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "mcp:admin"] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: toastSpy }));

const overview = {
  upstream_count: 2,
  enabled_upstream_count: 1,
  healthy_upstream_count: 1,
  total_tools: 7,
  total_prompts: 2,
  total_resources: 3,
  discovery_error_count: 1,
  blocked_count: 1,
  recent_call_count: 128,
  recent_error_rate: 0.0625,
  summary: { total_calls: 128, total_errors: 8, distinct_tools: 7, mcp_servers: 2 },
  fetched_at: "2026-09-06T10:00:00Z",
};

const routes = {
  routes: [
    {
      kind: "tool",
      exposed_name: "github__create_issue",
      uri: "",
      upstream_id: "github",
      upstream_name: "GitHub MCP",
      target_method: "tools/call",
      target_name: "create_issue",
      description: "이슈 생성",
      last_discovered_at: "2026-09-06T10:00:00Z",
      discovery_error: "",
    },
  ],
  fetched_at: "2026-09-06T10:00:00Z",
  errors: {},
};

const topology = {
  nodes: [
    { id: "gateway", label: "/mcp gateway", kind: "gateway" },
    { id: "upstream:github", label: "GitHub MCP", kind: "upstream", status: "enabled" },
    { id: "tool:github__create_issue", label: "github__create_issue", kind: "tool", decision: "allow" },
  ],
  edges: [{ from: "gateway", to: "upstream:github", label: "aggregates" }],
};

const upstreams = {
  upstreams: [
    {
      id: "github",
      name: "GitHub MCP",
      url: "https://mcp.example.com/mcp",
      has_auth: true,
      enabled: true,
      created_at: "2026-09-01T00:00:00Z",
      metadata: { risk_level: "high", requires_approval: true, description: "코드 도구" },
    },
  ],
  discovery_errors: {},
};

const emptyUpstreams = { upstreams: [], discovery_errors: {} };

const baseHandlers = {
  "GET /admin/mcp/overview": () => overview,
  "GET /admin/mcp/routes": () => routes,
  "GET /admin/mcp/topology": () => topology,
  "GET /admin/mcp/upstreams": () => upstreams,
};

function renderPage(route = "/mcp") {
  return renderScreen(<McpPage />, { route, path: "/mcp/*" });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "mcp:admin"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

describe("McpPage", () => {
  it("MCP 개요 지표와 라우트 맵을 보여 준다", async () => {
    mockApi(baseHandlers);
    renderPage();

    expect(await screen.findByText("128")).toBeInTheDocument();
    expect(screen.getByText("등록 업스트림")).toBeInTheDocument();
    expect(await screen.findByText("github__create_issue")).toBeInTheDocument();
  });

  it("URL 쿼리의 탭을 복원한다", async () => {
    mockApi(baseHandlers);
    renderPage("/mcp?tab=upstreams");

    expect(await screen.findByRole("tab", { name: /업스트림/, selected: true })).toBeInTheDocument();
    expect(await screen.findByText("GitHub MCP")).toBeInTheDocument();
  });

  it("업스트림이 없으면 빈 상태를 안내한다", async () => {
    mockApi({ ...baseHandlers, "GET /admin/mcp/upstreams": () => emptyUpstreams });
    renderPage("/mcp?tab=upstreams");

    expect(await screen.findByText("등록된 MCP 업스트림이 없습니다.")).toBeInTheDocument();
  });

  it("조회 실패 시 요청 ID를 포함한 오류를 알린다", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/mcp/overview": () => {
        throw apiFailure("overview failed", 500, "req_mcp_1");
      },
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/요청 ID: req_mcp_1/)).toBeInTheDocument();
  });

  it("mcp:admin 권한이 없으면 쓰기 작업을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(baseHandlers);
    renderPage("/mcp?tab=upstreams");

    const createButton = await screen.findByRole("button", { name: /업스트림 등록/ });
    expect(createButton).toBeDisabled();
    expect(screen.getByText("읽기 전용으로 열려 있습니다.")).toBeInTheDocument();
  });

  it("업스트림을 등록하면 입력한 값으로 저장을 호출한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/mcp/upstreams": () => emptyUpstreams,
      "POST /admin/mcp/upstreams": () => ({
        upstream: { id: "docs", name: "Docs MCP", url: "https://docs.example.com/mcp", enabled: true },
      }),
    });
    const user = userEvent.setup();
    renderPage("/mcp?tab=upstreams");

    await user.click(await screen.findByRole("button", { name: /업스트림 등록/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("표시 이름*"), "Docs MCP");
    await user.type(within(dialog).getByLabelText("MCP 엔드포인트 URL*"), "https://docs.example.com/mcp");
    await user.click(within(dialog).getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/mcp/upstreams")).toHaveLength(1);
    });
    expect(api.bodies("POST /admin/mcp/upstreams")[0]).toMatchObject({
      name: "Docs MCP",
      url: "https://docs.example.com/mcp",
      enabled: true,
    });
    await waitFor(() => {
      expect(toastSpy.success).toHaveBeenCalledWith("업스트림을 저장했습니다.");
    });
  });

  it("정책 탭에서 서버 정책을 삭제한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/mcp/policies": () => ({
        policies: [
          {
            server_label: "GitHub MCP",
            mode: "block",
            note: "위험 도구",
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-02T00:00:00Z",
          },
        ],
        allowlist_enabled: false,
      }),
      "GET /admin/mcp/loops": () => ({ loops: [], threshold: 10 }),
      "DELETE /admin/mcp/policies/GitHub%20MCP": () => ({ server_label: "GitHub MCP", status: "deleted" }),
    });
    const user = userEvent.setup();
    renderPage("/mcp?tab=policy");

    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "DELETE /admin/mcp/policies/GitHub%20MCP")).toBe(true);
    });
    await waitFor(() => {
      expect(toastSpy.success).toHaveBeenCalledWith("정책을 삭제했습니다.");
    });
  });

  it("접근성 위반이 없다", async () => {
    mockApi(baseHandlers);
    const { container } = renderPage();

    await screen.findByText("등록 업스트림");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
