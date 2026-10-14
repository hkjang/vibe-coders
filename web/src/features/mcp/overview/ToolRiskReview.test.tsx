import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpToolsTab } from "./McpToolsTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  write: true,
  read: true,
  permitted: true,
  readonly: false,
  mounted: true,
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: runtime.id },
        scopes: [...(runtime.read ? ["observability:read"] : []), ...(runtime.write ? ["mcp:admin"] : [])],
      }),
  };
});
const row = {
  server_label: "public-server",
  tool_name: "write_item",
  access_class: "write",
  risk_level: "high",
  action: "require_approval",
  recommended_action: "require_approval",
  configured: true,
  note: "원래 메모",
};
const result = { tools: [], tool_risk: [row], risk_profiles: [], count: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/mcp/tools": () => result,
    "GET /admin/mcp/servers": () => ({ servers: [] }),
    "GET /admin/mcp/catalog": () => ({ catalog: [], new_count: 0 }),
    "GET /admin/mcp/trust-scores": () => ({ tools: [] }),
    "POST /admin/mcp/tools": () => ({ profile: row }),
    ...handlers,
  });
  let refresh = () => {};
  function Harness() {
    const [, update] = useReducer((n) => n + 1, 0);
    refresh = () => update();
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "mcp.overview",
          permitted: runtime.permitted,
          readOnly: runtime.readonly,
          status: "preview",
        }}
      >
        {runtime.mounted ? <McpToolsTab canWrite={runtime.write} /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Harness />, { route: "/mcp", path: "/mcp" });
  return { ...view, api, refresh: () => act(() => refresh()) };
}
async function edit() {
  await userEvent.click(
    await screen.findByRole("button", { name: "public-server write_item 위험 등급 편집" }),
  );
  return screen.getByRole("dialog", { name: "도구 위험 등급" });
}
async function change(dialog: HTMLElement) {
  await userEvent.clear(within(dialog).getByLabelText("메모"));
  await userEvent.type(within(dialog).getByLabelText("메모"), "새 메모");
}
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "검토한 변경 저장" });
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    write: true,
    read: true,
    permitted: true,
    readonly: false,
    mounted: true,
  });
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("MCP 도구 위험 설정 검토", () => {
  it.each([
    [
      ["server a", "tool"],
      ["server", "a tool"],
    ],
    [
      ["server/a", "tool"],
      ["server", "a/tool"],
    ],
  ])("구분자가 있는 서버·도구 쌍의 통계를 혼동하지 않는다", async (first, second) => {
    const rows = [first, second].map(([server_label, tool_name]) => ({
      ...row,
      server_label: server_label ?? "",
      tool_name: tool_name ?? "",
    }));
    setup({
      "GET /admin/mcp/tools": () => ({
        ...result,
        tool_risk: rows,
        tools: rows.map((item, index) => ({ ...item, calls: index ? 99 : 11 })),
      }),
    });
    const table = await screen.findByRole("table", { name: "MCP 도구 위험 등급" });
    await within(table).findByText("11", { exact: true });
    const items = within(table).getAllByRole("row").slice(1);
    expect(items).toHaveLength(2);
    const [firstRow, secondRow] = items;
    if (!firstRow || !secondRow) throw new Error("expected two tool rows");
    expect(within(firstRow).getByText("11", { exact: true })).toBeInTheDocument();
    expect(within(secondRow).getByText("99", { exact: true })).toBeInTheDocument();
  });
  it("관리자 조회 권한을 추가 요구하지 않고 실제 MCP 조회 권한을 사용한다", async () => {
    const { api } = setup();
    const dialog = await edit();
    expect(save(dialog)).toBeDisabled();
    await change(dialog);
    expect(within(dialog).getByText("변경 전: 원래 메모")).toBeInTheDocument();
    expect(within(dialog).getByText("변경 후: 새 메모")).toBeInTheDocument();
    await userEvent.click(save(dialog));
    await waitFor(() =>
      expect(api.bodies("POST /admin/mcp/tools")).toEqual([
        {
          server_label: row.server_label,
          tool_name: row.tool_name,
          risk_level: "high",
          action: "require_approval",
          note: "새 메모",
        },
      ]),
    );
    expect(
      api.spy.mock.calls.some(
        ([endpoint, options]) => endpoint.path === "/admin/mcp/tools" && options?.retryUnauthorized === false,
      ),
    ).toBe(true);
  });
  it("MCP 조회 권한이 없으면 요청과 이전 편집을 표시하지 않는다", () => {
    runtime.read = false;
    const { api } = setup();
    expect(screen.getByText(/observability:read/u)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
  it("추론된 기본값을 고정하는 변경도 비교한다", async () => {
    setup({ "GET /admin/mcp/tools": () => ({ ...result, tool_risk: [{ ...row, configured: false }] }) });
    const dialog = await edit();
    expect(within(dialog).getByText("변경 전: 추론된 기본값")).toBeInTheDocument();
    expect(within(dialog).getByText("변경 후: 이 도구의 고정 설정")).toBeInTheDocument();
    expect(save(dialog)).toBeEnabled();
  });
  it("알 수 없는 값을 낮음·허용으로 자동 변경하지 않는다", async () => {
    setup({
      "GET /admin/mcp/tools": () => ({
        ...result,
        tool_risk: [{ ...row, risk_level: "future-level", action: "future-action" }],
      }),
    });
    const dialog = await edit();
    const risk = within(dialog).getByLabelText("위험 등급*");
    const action = within(dialog).getByLabelText("조치*");
    expect(risk).toHaveValue("future-level");
    expect(action).toHaveValue("future-action");
    await change(dialog);
    expect(save(dialog)).toBeDisabled();
    await userEvent.selectOptions(risk, "high");
    expect(save(dialog)).toBeDisabled();
    await userEvent.selectOptions(action, "block");
    expect(save(dialog)).toBeEnabled();
  });
  it("메모 삭제를 비교하고 빈 문자열을 명시적으로 저장한다", async () => {
    const { api } = setup();
    const dialog = await edit();
    await userEvent.clear(within(dialog).getByLabelText("메모"));
    expect(within(dialog).getByText("변경 후: 없음")).toBeInTheDocument();
    await userEvent.click(save(dialog));
    await waitFor(() =>
      expect(api.bodies("POST /admin/mcp/tools")).toEqual([expect.objectContaining({ note: "" })]),
    );
  });
  it.each(["write", "readonly"] as const)("%s 제한은 입력을 보존하고 저장을 막는다", async (kind) => {
    const { refresh, api } = setup();
    const dialog = await edit();
    await change(dialog);
    if (kind === "write") runtime.write = false;
    else runtime.readonly = true;
    refresh();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("메모")).toHaveValue("새 메모");
    expect(save(dialog)).toBeDisabled();
    await userEvent.click(save(dialog));
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(0);
  });
  it.each(["id", "read", "permitted", "mounted"] as const)(
    "%s 변경은 편집과 늦은 저장 결과를 폐기한다",
    async (kind) => {
      const held = deferred<{ profile: typeof row }>();
      const { refresh, api } = setup({ "POST /admin/mcp/tools": () => held.promise });
      const dialog = await edit();
      await change(dialog);
      await userEvent.click(save(dialog));
      await waitFor(() => expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(1));
      if (kind === "id") runtime.id = "public-b";
      else runtime[kind] = false;
      refresh();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => held.resolve({ profile: row }));
      expect(notices.success).not.toHaveBeenCalled();
      expect(notices.error).not.toHaveBeenCalled();
    },
  );
  it.each(["changed", "missing"])("저장 직전 %s 설정이면 덮어쓰지 않는다", async (scenario) => {
    let reads = 0;
    const { api } = setup({
      "GET /admin/mcp/tools": () =>
        ++reads === 1
          ? result
          : { ...result, tool_risk: scenario === "missing" ? [] : [{ ...row, note: "다른 관리자" }] },
    });
    const dialog = await edit();
    await change(dialog);
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText("현재 설정을 다시 확인하세요.")).toBeInTheDocument();
    expect(save(dialog)).toBeDisabled();
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(0);
    expect(within(dialog).getByLabelText("메모")).toHaveValue("새 메모");
  });
  it("저장 직전 조회 중 권한이 회수되면 POST하지 않는다", async () => {
    const held = deferred<typeof result>();
    let reads = 0;
    const { api, refresh } = setup({ "GET /admin/mcp/tools": () => (++reads === 1 ? result : held.promise) });
    const dialog = await edit();
    await change(dialog);
    await userEvent.click(save(dialog));
    await waitFor(() => expect(reads).toBe(2));
    runtime.write = false;
    refresh();
    await act(async () => held.resolve(result));
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(0);
  });
  it.each([401, 403])("저장 직전 %s 조회 거부는 이전 데이터와 편집을 지운다", async (status) => {
    let reads = 0;
    const { api } = setup({
      "GET /admin/mcp/tools": () => {
        if (++reads > 1) throw apiFailure("private", status);
        return result;
      },
    });
    const dialog = await edit();
    await change(dialog);
    await userEvent.click(save(dialog));
    expect(await screen.findByText("MCP 도구 조회 권한을 다시 확인하세요.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(0);
  });
  it("중복 저장과 화면 재생성 뒤 같은 계정의 재전송을 막는다", async () => {
    const held = deferred<{ profile: typeof row }>();
    const { api, refresh } = setup({ "POST /admin/mcp/tools": () => held.promise });
    const dialog = await edit();
    await change(dialog);
    await userEvent.dblClick(save(dialog));
    await waitFor(() => expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(1));
    runtime.mounted = false;
    refresh();
    runtime.mounted = true;
    refresh();
    const next = await edit();
    await change(next);
    await userEvent.click(save(next));
    await waitFor(() => expect(within(next).getByRole("alert")).toBeInTheDocument());
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(1);
    await act(async () => held.resolve({ profile: row }));
    expect(notices.success).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])("POST %s는 자동 재전송하지 않고 요청 ID를 표시한다", async (status) => {
    const { api } = setup({
      "POST /admin/mcp/tools": () => {
        throw apiFailure("private", status, "public-mcp-request");
      },
    });
    const dialog = await edit();
    await change(dialog);
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText(/public-mcp-request/u)).toBeInTheDocument();
    expect(api.bodies("POST /admin/mcp/tools")).toHaveLength(1);
  });
  it("초기 조회 실패를 정상 빈 도구로 표시하지 않는다", async () => {
    setup({
      "GET /admin/mcp/tools": () => {
        throw apiFailure("private", 500);
      },
    });
    expect(await screen.findByText("도구 위험 등급을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByText("조건에 맞는 도구가 없습니다.")).not.toBeInTheDocument();
  });
});
