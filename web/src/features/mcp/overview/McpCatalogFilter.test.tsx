import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { McpToolsTab } from "./McpToolsTab";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "observability:read"] }) };
});
it("이름 검색에서 연 도구 카탈로그는 선택 도구와 MCP 필터에 맞는 신규 수만 보여준다", async () => {
  const stamp = "2026-11-13T00:00:00Z";
  const catalog = [
    { tool_name: "lookup", is_mcp: true, is_new: true },
    { tool_name: "other", is_mcp: true, is_new: true },
    { tool_name: "lookup", is_mcp: false, is_new: true },
  ].map((row) => ({
    server_label: "server-a",
    first_seen: stamp,
    last_seen: stamp,
    is_stale: false,
    ...row,
  }));
  const api = mockApi({
    "GET /admin/mcp/tools": () => ({ tools: [], tool_risk: [], risk_profiles: [], count: 0 }),
    "GET /admin/mcp/servers": () => ({ servers: [] }),
    "GET /admin/mcp/catalog": () => ({ catalog, new_count: 3 }),
    "GET /admin/mcp/trust-scores": () => ({ tools: [] }),
  });
  renderScreen(
    <FeatureAccessHarness featureId="mcp.overview">
      <McpToolsTab canWrite={false} />
    </FeatureAccessHarness>,
    { path: "/mcp", route: "/mcp?tab=tools&server=server-a&tool=lookup&mcp_only=1" },
  );
  const table = await screen.findByRole("table", { name: "MCP 도구 카탈로그" });
  expect(await within(table).findByText("lookup")).toBeVisible();
  expect(within(table).queryByText("other")).not.toBeInTheDocument();
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  expect(screen.getByText("신규 1개")).toBeVisible();
  expect(
    api.spy.mock.calls.filter(([endpoint]) => endpoint.path === "/admin/mcp/catalog")[0]?.[1],
  ).toMatchObject({ query: { server: "server-a" } });
});
