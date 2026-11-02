import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRequestsTab } from "./McpRequestsTab";
import { validMcpRequestId } from "./mcp-request-location";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "reader-a", read: true, permitted: true, raw: true, mounted: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({
        user: { id: runtime.id },
        rawPromptView: runtime.raw,
        scopes: runtime.read ? ["observability:read"] : ["admin:read"],
      }),
      credentialPrefixes: ["custom_"],
    }),
  };
});
const request = {
  id: "public-request",
  model: "public-model",
  status_code: 200,
  latency_ms: 0,
  tool_count: 1,
  api_key_id: "public-key-id",
  created_at: "2026-10-14T00:00:00Z",
};
const flow = {
  request_id: request.id,
  trace_id: "public-trace",
  api_key_id: "public-key-id",
  status: 200,
  latency_ms: 0,
  steps: [{ name: "policy_evaluation", status: "block", detail: "현재 정책" }],
  tools: [
    {
      server_label: "public-server",
      tool_name: "public-tool",
      is_mcp: true,
      is_error: false,
      created_at: request.created_at,
    },
  ],
};
const listKey = "GET /admin/mcp/requests";
const flowKey = "GET /admin/mcp/requests/public-request/waterfall";
const agentKey = "GET /admin/mcp/agentic-runs";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(handlers: Record<string, ApiHandler> = {}, route = "/mcp?tab=requests") {
  const api = mockApi({
    [listKey]: () => ({ requests: [request] }),
    [flowKey]: () => flow,
    [agentKey]: () => ({ request_id: request.id, agentic: false, note: "실행 기록 없음" }),
    ...handlers,
  });
  let refresh = () => {};
  let navigate: ReturnType<typeof useNavigate> = () => {};
  function Harness() {
    const [, update] = useReducer((n) => n + 1, 0);
    refresh = () => update();
    navigate = useNavigate();
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
        {runtime.mounted ? <McpRequestsTab /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Harness />, { route, path: "/mcp" });
  return {
    ...view,
    api,
    refresh: () => act(() => refresh()),
    go: (path: string) => act(() => navigate(path)),
  };
}
const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "public-request 처리 흐름 열기" }));
  return screen.findByRole("dialog", { name: "MCP 요청 처리 흐름" });
};
beforeEach(() => {
  Object.assign(runtime, { id: "reader-a", read: true, permitted: true, raw: true, mounted: true });
});
afterEach(() => vi.restoreAllMocks());

describe("MCP 요청 조회 안전성", () => {
  it.each([
    ["approval_required", "승인 필요"],
    ["not_in_allowlist", "허용목록 외"],
  ])("서버의 %s 상태를 한글로 표시한다", async (status, label) => {
    setup({
      [flowKey]: () => ({ ...flow, steps: [{ name: "governance_evaluation", status, detail: "현재 판단" }] }),
    });
    const dialog = await open();
    expect(await within(dialog).findByText(label ?? "")).toBeVisible();
    expect(within(dialog).queryByText(status ?? "")).not.toBeInTheDocument();
  });
  it("관리자·변경 권한 없이 실제 조회 권한으로 목록과 상세를 연다", async () => {
    const { api } = setup();
    const dialog = await open();
    expect(await within(dialog).findByText("public-trace")).toBeVisible();
    expect(within(dialog).getByText("현재 서버 정책")).toBeVisible();
    expect(within(dialog).getByText(/호출 당시 적용된 정책이나 실제 단계별/)).toBeVisible();
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });
  it("관리자 조회 권한만 있으면 MCP 요청을 조회하지 않는다", async () => {
    runtime.read = false;
    const { api } = setup();
    expect(await screen.findByText(/필요 권한: observability:read/)).toBeVisible();
    expect(api.calls).toHaveLength(0);
  });
  it("초기 목록 오류를 빈 결과로 표시하지 않고 수동 재시도한다", async () => {
    let fail = true;
    const { api } = setup({
      [listKey]: () => {
        if (fail) throw apiFailure("unavailable");
        return { requests: [] };
      },
    });
    expect(await screen.findByText("MCP 요청 로그 조회에 실패했습니다.")).toBeVisible();
    expect(screen.queryByText("MCP 호출 기록이 없습니다.")).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(1);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "MCP 요청 로그 다시 시도" }));
    expect(await screen.findByText("MCP 호출 기록이 없습니다.")).toBeVisible();
  });
  it("상세 로딩 중 도구 호출이 없다고 표시하지 않는다", async () => {
    const held = deferred<typeof flow>();
    setup({ [flowKey]: () => held.promise });
    const dialog = await open();
    expect(within(dialog).queryByText("도구 호출이 없습니다.")).not.toBeInTheDocument();
    await act(async () => held.resolve(flow));
    expect(await within(dialog).findByText("public-server/public-tool")).toBeVisible();
  });
  it("처리 흐름 실패와 에이전트 기록 성공을 구분한다", async () => {
    setup({
      [flowKey]: () => {
        throw apiFailure("flow unavailable", 500, "public-flow-error");
      },
    });
    const dialog = await open();
    expect(await within(dialog).findByText("처리 흐름 조회에 실패했습니다.")).toBeVisible();
    expect(within(dialog).getByText("요청 ID: public-flow-error")).toBeVisible();
    expect(within(dialog).getByText("기록 없음")).toBeVisible();
    expect(within(dialog).queryByText("도구 호출이 없습니다.")).not.toBeInTheDocument();
  });
  it("에이전트 기록 실패에 별도 재시도를 제공한다", async () => {
    let fail = true;
    const { api } = setup({
      [agentKey]: () => {
        if (fail) throw apiFailure("run unavailable");
        return { agentic: true };
      },
    });
    const dialog = await open();
    expect(await within(dialog).findByText("에이전트 실행 기록 조회에 실패했습니다.")).toBeVisible();
    expect(within(dialog).getByText("확인 불가")).toBeVisible();
    expect(within(dialog).getByText("public-trace")).toBeVisible();
    fail = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "에이전트 실행 기록 다시 시도" }));
    expect(await within(dialog).findByText("기록 있음")).toBeVisible();
    expect(api.calls.filter((call) => call.key === flowKey)).toHaveLength(1);
  });
  it("일반 갱신 실패에는 이전 데이터와 실패 안내를 함께 유지한다", async () => {
    let fail = false;
    const { client } = setup({
      [listKey]: () => {
        if (fail) throw apiFailure("offline");
        return { requests: [request] };
      },
    });
    await screen.findByText("public-model");
    fail = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["mcp", "requests"] });
    });
    expect(
      await screen.findByText("MCP 요청 로그 갱신에 실패해 마지막 정상 데이터를 표시합니다."),
    ).toBeVisible();
    expect(screen.getByText("public-model")).toBeVisible();
  });
  it.each([401, 403])("상세 %i는 목록과 상세를 폐기하고 수동 확인 후 복구한다", async (status) => {
    const { api } = setup({
      [flowKey]: () => {
        throw apiFailure("denied", status);
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "public-request 처리 흐름 열기" }));
    expect(await screen.findByText("MCP 요청 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByText("public-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /다시/ }));
    expect(await screen.findByText("public-model")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.key === flowKey)).toHaveLength(1);
  });
  it.each(["id", "read", "permitted", "raw", "mounted"] as const)(
    "%s 변경 뒤 이전 보류 응답을 사용하지 않는다",
    async (key) => {
      const held = deferred<typeof flow>();
      let first = true;
      const view = setup({
        [flowKey]: () => {
          if (first) {
            first = false;
            return held.promise;
          }
          return { ...flow, trace_id: "current-trace" };
        },
      });
      await open();
      if (key === "id") runtime.id = "reader-b";
      else runtime[key] = false;
      view.refresh();
      await act(async () => held.resolve({ ...flow, trace_id: "retired-trace" }));
      expect(screen.queryByText("retired-trace")).not.toBeInTheDocument();
      expect(
        JSON.stringify(
          view.client
            .getQueryCache()
            .getAll()
            .map((q) => q.state.data),
        ),
      ).not.toContain("retired-trace");
      if (key === "id" || key === "raw") expect(await screen.findByText("current-trace")).toBeVisible();
      else expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it("초기화와 주소 변경 시 오류 필터를 복원한다", async () => {
    const view = setup({}, "/mcp?tab=requests&errors=1");
    const checkbox = () => screen.getByRole("checkbox", { name: "오류만 보기" });
    expect(checkbox()).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "초기화" }));
    expect(checkbox()).not.toBeChecked();
    view.go("/mcp?tab=requests&errors=1");
    expect(checkbox()).toBeChecked();
    await waitFor(() =>
      expect(view.api.calls.at(-1)?.options.query).toMatchObject({ errors: "1", limit: 50 }),
    );
  });
  it("아직 적용하지 않은 서버·도구·오류 입력도 초기화한다", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("서버 라벨"), "draft-server");
    await userEvent.type(screen.getByLabelText("도구 이름"), "draft-tool");
    await userEvent.click(screen.getByRole("checkbox", { name: "오류만 보기" }));
    await userEvent.click(screen.getByRole("button", { name: "초기화" }));
    expect(screen.getByLabelText("서버 라벨")).toHaveValue("");
    expect(screen.getByLabelText("도구 이름")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "오류만 보기" })).not.toBeChecked();
  });
  it("사용자 지정 비밀 접두사 검색을 URL 변경 전에 거부하고 입력에 초점을 둔다", async () => {
    setup();
    const input = screen.getByLabelText("서버 라벨");
    await userEvent.type(input, "custom_" + "a".repeat(32));
    await userEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(screen.getByText(/인증정보로 보이는 검색어/)).toBeVisible();
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("custom_");
  });
  it("상세를 닫으면 상세 버튼으로 키보드 초점을 복원한다", async () => {
    setup();
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "패널 닫기" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "public-request 처리 흐름 열기" })).toHaveFocus(),
    );
  });
  it("지원하지 않는 직접 상세 주소를 요청하지 않는다", async () => {
    const { api } = setup({}, "/mcp?tab=requests&request_id=..");
    expect(await screen.findByText("MCP 요청 조회 주소를 확인하세요.")).toBeVisible();
    expect(api.calls).toHaveLength(0);
  });
});

describe("기존 MCP 요청 ID 경계", () => {
  it.each(["", " ", ".", "..", "a/b", "a\n", "a\u0085", "\ud800", "한".repeat(1366)])(
    "지원하지 않는 ID %j",
    (id) => {
      expect(validMcpRequestId(id)).toBe(false);
    },
  );
  it.each(["public-id", "공개 요청", "a?b#c", "한".repeat(1365)])("호환 가능한 ID", (id) => {
    expect(validMcpRequestId(id)).toBe(true);
  });
});
