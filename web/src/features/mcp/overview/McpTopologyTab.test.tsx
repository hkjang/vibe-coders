import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mcpTopologySchema, type McpTopology } from "@/shared/api/domains/mcp.schemas";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import McpTopologyTab from "./McpTopologyTab";
import {
  filterTopology,
  layoutTopology,
  topologyKind,
  topologyModel,
  topologyState,
} from "./mcp-topology-model";

const runtime = vi.hoisted(() => ({ id: "reader-a", read: true, permitted: true, mounted: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ user: { id: runtime.id }, scopes: runtime.read ? ["observability:read"] : [] }),
      credentialPrefixes: ["custom_"],
    }),
  };
});
const key = "GET /admin/mcp/topology";
const data: McpTopology = mcpTopologySchema.parse({
  nodes: [
    { id: "gateway", label: "공개 게이트웨이", kind: "gateway" },
    { id: "upstream:public", label: "공개 서버", kind: "upstream", status: "enabled" },
    { id: "tool:read", label: "공개 읽기 도구", kind: "tool", decision: "block" },
  ],
  edges: [
    { from: "gateway", to: "upstream:public", label: "aggregates" },
    { from: "upstream:public", to: "tool:read", label: "tools/call" },
  ],
});
function setup(handler: ApiHandler = () => data, route = "/mcp?tab=topology") {
  const api = mockApi({ [key]: handler });
  let refresh = () => {};
  function Harness() {
    const [, update] = useReducer((n) => n + 1, 0);
    refresh = () => update();
    const location = useLocation();
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "mcp.overview",
          permitted: runtime.permitted,
          readOnly: true,
          status: "preview_read_only",
        }}
      >
        <output aria-label="현재 주소">{location.search}</output>
        {runtime.mounted ? <McpTopologyTab /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  return { ...renderScreen(<Harness />, { route, path: "/mcp" }), api, refresh: () => act(() => refresh()) };
}
beforeEach(() => {
  Object.assign(runtime, { id: "reader-a", read: true, permitted: true, mounted: true });
});

describe("MCP 연결 구조", () => {
  it("조회 권한으로 연결도와 목록·상세를 제공하며 쓰기를 하지 않는다", async () => {
    const { api } = setup();
    const trigger = await screen.findByRole("button", { name: "공개 서버 연결 상세" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "MCP 연결 상세" });
    expect(within(dialog).getByText("게이트웨이 통합")).toBeVisible();
    expect(within(dialog).getByText("tools/call")).toBeVisible();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("node=upstream%3Apublic");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.calls.map((call) => call.key)).toEqual([key]);
  });
  it("상세 주소를 복원하고 연결 대상을 탐색한다", async () => {
    setup(undefined, "/mcp?tab=topology&node=upstream%3Apublic");
    const dialog = await screen.findByRole("dialog", { name: "MCP 연결 상세" });
    await userEvent.click(within(dialog).getByRole("button", { name: "공개 읽기 도구" }));
    expect(within(dialog).getByText("차단")).toBeVisible();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("node=tool%3Aread");
  });
  it("필터와 페이지를 주소에 반영하고 결과 없음을 구분한다", async () => {
    setup();
    await screen.findByRole("table", { name: "MCP 연결 노드" });
    await userEvent.selectOptions(screen.getByLabelText("종류"), "tool");
    expect(screen.getByRole("table", { name: "MCP 연결 노드" })).not.toHaveTextContent("공개 서버");
    await userEvent.type(screen.getByLabelText("이름·노드 ID 검색"), "존재하지않음");
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByText("조건에 맞는 노드가 없습니다.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(await screen.findByRole("table", { name: "MCP 연결 노드" })).toHaveTextContent("공개 서버");
  });
  it("자격정보 검색은 주소에 저장하지 않는다", async () => {
    setup();
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("이름·노드 ID 검색"), "custom_" + "x".repeat(48));
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("custom_");
    expect(screen.getByRole("alert")).toBeVisible();
  });
  it("실패를 빈 구조로 표시하지 않고 재시도한다", async () => {
    let fail = true;
    setup(() => {
      if (fail) throw apiFailure("unavailable", 503);
      return data;
    });
    expect(await screen.findByText("MCP 연결 구조 조회에 실패했습니다.")).toBeVisible();
    expect(screen.queryByText("수신한 연결 노드가 없습니다.")).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "MCP 연결 구조 다시 시도" }));
    expect(await screen.findByRole("table")).toHaveTextContent("공개 서버");
  });
  it("일반 갱신 실패는 마지막 정상 결과와 안내를 보존한다", async () => {
    let fail = false;
    setup(() => {
      if (fail) throw apiFailure("unavailable", 503);
      return data;
    });
    await screen.findByRole("table");
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "연결 구조 새로고침" }));
    expect(
      await screen.findByText("MCP 연결 구조 갱신에 실패해 마지막 정상 데이터를 표시합니다."),
    ).toBeVisible();
    expect(screen.getByRole("table")).toHaveTextContent("공개 서버");
  });
  it.each([401, 403])("조회 %i는 기존 구조를 폐기한다", async (status) => {
    let fail = false;
    setup(() => {
      if (fail) throw apiFailure("denied", status);
      return data;
    });
    await screen.findByRole("table");
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "연결 구조 새로고침" }));
    expect(await screen.findByText("연결 구조 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("table")).toBeVisible();
  });
  it.each(["id", "read", "permitted", "mounted"] as const)(
    "%s 변경 뒤 늦은 결과를 폐기한다",
    async (field) => {
      let resolve!: (value: McpTopology) => void;
      const held = new Promise<McpTopology>((done) => {
        resolve = done;
      });
      let first = true;
      const view = setup(() => {
        if (first) {
          first = false;
          return held;
        }
        return { nodes: [], edges: [] };
      });
      await waitFor(() => expect(view.api.calls.length).toBe(1));
      if (field === "id") runtime.id = "reader-b";
      else runtime[field] = false;
      view.refresh();
      await act(async () => {
        resolve(data);
      });
      expect(screen.queryByText("공개 서버")).not.toBeInTheDocument();
    },
  );
  it("권한이 없으면 API를 호출하지 않는다", () => {
    runtime.read = false;
    const { api } = setup();
    expect(api.calls).toHaveLength(0);
  });
  it("누락된 연결과 선택한 노드의 부재를 명시한다", async () => {
    setup(
      () => ({
        ...data,
        edges: [...data.edges, { from: "upstream:public", to: "missing", label: "tools/call" }],
      }),
      "/mcp?tab=topology&node=missing",
    );
    expect(await screen.findByText("일부 연결 대상을 확인할 수 없습니다.")).toBeVisible();
    expect(screen.getByText("선택한 노드가 현재 목록에 없습니다.")).toBeVisible();
  });
  it("전체 수신 목록의 페이지를 나누고 60개 연결도 상한을 알린다", async () => {
    const nodes = Array.from({ length: 81 }, (_, index) => ({
      id: String(index),
      label: `노드 ${index}`,
      kind: "tool",
      decision: "allow",
      status: "",
    }));
    setup(() => ({ nodes, edges: [] }), "/mcp?tab=topology&topology_page=2");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(26);
    expect(table).toHaveTextContent("노드 25");
    expect(table).not.toHaveTextContent("노드 50");
    expect(screen.getByText(/최대 60개/)).toBeInTheDocument();
    expect(document.querySelectorAll(".mcp-topology-node")).toHaveLength(60);
  });
});

describe("연결 구조 계약과 탐색 모델", () => {
  it.each([
    {},
    { nodes: null, edges: [] },
    { nodes: [], edges: null },
    { ...data, nodes: [...data.nodes, data.nodes[0]] },
    { nodes: [{ id: "", label: "bad", kind: "tool" }], edges: [] },
  ])("불완전·중복 응답을 거부한다", (value) => {
    expect(mcpTopologySchema.safeParse(value).success).toBe(false);
  });
  it("알 수 없는 종류와 상태를 안전하게 보존한다", () => {
    expect(topologyKind("constructor")).toBe("constructor");
    expect(topologyState("__proto__")).toBe("__proto__");
  });
  it("순환·자기 연결·누락에도 종료하며 연결 방향을 유지한다", () => {
    const model = topologyModel({
      ...data,
      edges: [
        ...data.edges,
        { from: "tool:read", to: "gateway", label: "cycle" },
        { from: "tool:read", to: "tool:read", label: "self" },
        { from: "missing", to: "tool:read", label: "missing" },
      ],
    });
    expect(model.missing).toHaveLength(1);
    expect(model.disconnected).toHaveLength(0);
    expect(model.incoming.get("tool:read")).toHaveLength(3);
  });
  it("한글 상태 필터와 빈 레이아웃을 처리한다", () => {
    expect(filterTopology(data.nodes, "차단", "tool", "block")).toHaveLength(1);
    expect(layoutTopology([])).toMatchObject({ positions: [], height: 220 });
  });
});
