import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayMcpPage } from "@/features/mcp/gateway/GatewayMcpPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "mcp:admin"] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: toastSpy }));

const info = {
  endpoint: "/mcp/gateway",
  protocol_version: "2025-06-18",
  note: "외부 AI 에이전트가 Proxy API Key로 연결합니다.",
  tools: [{ name: "gateway_chat", description: "게이트웨이 chat completion" }],
  contracts: [
    {
      name: "gateway_chat",
      risk_level: "medium",
      cost_policy: "per_call_model_cost",
      timeout_ms: 120000,
      allowed_roles: "",
      executes: true,
      output_schema: "OpenAI chat.completion object",
    },
  ],
  resources: [
    { uri: "gateway://models", name: "models", description: "모델 목록", mimeType: "application/json" },
  ],
  prompts: [{ name: "use_gateway_safely", description: "안전 사용 안내" }],
};

const contracts = {
  contracts: [
    {
      id: "mtc_1",
      namespace: "gateway",
      name: "gateway_chat",
      title: "Gateway Chat",
      description: "",
      input_schema: '{"type":"object","properties":{"model":{"type":"string"}}}',
      output_schema: "",
      risk_level: "medium",
      timeout_ms: 120000,
      allowed_roles: "",
      cost_policy: "per_call_model_cost",
      owner: "platform",
      enabled: true,
      created_by: "admin",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
};

const baseHandlers = {
  "GET /admin/gateway-mcp/info": () => info,
  "GET /admin/mcp/contracts": () => contracts,
};

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "mcp:admin"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

describe("GatewayMcpPage", () => {
  it("연결 정보와 도구, 계약을 보여 준다", async () => {
    mockApi(baseHandlers);
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    expect(await screen.findByText("/mcp/gateway")).toBeInTheDocument();
    expect(await screen.findAllByText("gateway_chat")).not.toHaveLength(0);
    expect(screen.getByText("2025-06-18")).toBeInTheDocument();
  });

  it("계약이 없으면 빈 상태를 안내한다", async () => {
    mockApi({ ...baseHandlers, "GET /admin/mcp/contracts": () => ({ contracts: [] }) });
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    expect(await screen.findByText("등록된 도구 계약이 없습니다.")).toBeInTheDocument();
  });

  it("조회 실패 시 요청 ID를 포함한 오류를 알린다", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/gateway-mcp/info": () => {
        throw apiFailure("info failed", 500, "req_gw_1");
      },
    });
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/요청 ID: req_gw_1/)).toBeInTheDocument();
  });

  it("mcp:admin 권한이 없으면 계약 등록과 검증을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(baseHandlers);
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    expect(await screen.findByRole("button", { name: /계약 등록/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "드리프트 검증" })).toBeDisabled();
  });

  it("드리프트 검증 결과를 표로 보여 준다", async () => {
    mockApi({
      ...baseHandlers,
      "POST /admin/mcp/contracts/validate": () => ({
        checked: 1,
        drift_count: 1,
        missing_count: 0,
        note: "스키마 속성 키 집합을 비교합니다.",
        results: [
          {
            contract_id: "mtc_1",
            namespace: "gateway",
            name: "gateway_chat",
            risk_level: "medium",
            status: "drift",
            detail: "선언된 입력 스키마와 실제 노출 스키마가 다릅니다.",
            declared_only: [],
            live_only: ["messages"],
          },
        ],
      }),
    });
    const user = userEvent.setup();
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    await user.click(await screen.findByRole("button", { name: "드리프트 검증" }));

    expect(await screen.findByText(/드리프트 1건/)).toBeInTheDocument();
    expect(await screen.findByText(/실제에만: messages/)).toBeInTheDocument();
  });

  it("도구 계약을 삭제한다", async () => {
    const api = mockApi({
      ...baseHandlers,
      "DELETE /admin/mcp/contracts": () => ({ id: "mtc_1", ok: true }),
    });
    const user = userEvent.setup();
    renderScreen(<GatewayMcpPage />, { route: "/mcp-gateway", path: "/mcp-gateway/*" });

    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(api.calls.filter((call) => call.key === "DELETE /admin/mcp/contracts")).toHaveLength(1);
    });
    expect(api.calls.find((call) => call.key === "DELETE /admin/mcp/contracts")?.options.query).toEqual({
      id: "mtc_1",
    });
    await waitFor(() => {
      expect(toastSpy.success).toHaveBeenCalledWith("도구 계약을 삭제했습니다.");
    });
  });

  it("접근성 위반이 없다", async () => {
    mockApi(baseHandlers);
    const { container } = renderScreen(<GatewayMcpPage />, {
      route: "/mcp-gateway",
      path: "/mcp-gateway/*",
    });

    await screen.findByText("/mcp/gateway");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
