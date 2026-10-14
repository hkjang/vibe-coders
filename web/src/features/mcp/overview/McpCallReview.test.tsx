import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpOverviewTab } from "./McpOverviewTab";
import { callCommand, callable, callReason, checkedExplanation, emptyCall } from "./mcp-call-review";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  read: true,
  write: true,
  readonly: false,
  permitted: true,
  mounted: true,
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({
        user: { id: runtime.id },
        scopes: [...(runtime.read ? ["observability:read"] : []), ...(runtime.write ? ["mcp:admin"] : [])],
      }),
      credentialPrefixes: ["custom_"],
    }),
  };
});
const input = { method: "tools/call", name: "public__read", uri: "" };
const explanation = {
  input,
  route: {
    found: true,
    upstream_id: "public-id",
    upstream_name: "공개 서버",
    target_method: "tools/call",
    target_name: "read",
    lookup: "public__read",
  },
  policy: {
    server_policy: "allow",
    tool_risk_level: "low",
    tool_risk_action: "allow",
    tool_risk_configured: false,
    tool_risk_note: "",
  },
  final: { decision: "allow", reason: "route found and policy allows call" },
};
const result = {
  ok: true,
  upstream_id: "public-id",
  upstream_name: "공개 서버",
  method: "tools/call",
  latency_ms: 4,
  response_preview: "공개 응답",
};
const explainKey = "POST /admin/mcp/route/explain",
  testKey = "POST /admin/mcp/test";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/mcp/overview": () => ({
      upstream_count: 1,
      enabled_upstream_count: 1,
      total_tools: 1,
      recent_call_count: 22,
    }),
    "GET /admin/mcp/routes": () => ({ routes: [], errors: {} }),
    "GET /admin/mcp/topology": () => ({ nodes: [], edges: [] }),
    [explainKey]: () => explanation,
    [testKey]: () => result,
    ...handlers,
  });
  let refresh = () => {};
  function Harness() {
    const [, update] = useReducer((n) => n + 1, 0);
    refresh = update;
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "mcp.overview",
          readOnly: runtime.readonly,
          permitted: runtime.permitted,
          status: "preview",
        }}
      >
        {runtime.mounted ? <McpOverviewTab canWrite={runtime.write} /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Harness />, { route: "/mcp", path: "/mcp" });
  return { ...view, api, refresh: () => act(() => refresh()) };
}
async function inspect() {
  await userEvent.type(await screen.findByLabelText("노출 이름"), input.name);
  await userEvent.click(screen.getByRole("button", { name: "적용 경로 확인" }));
  await screen.findByText("확인한 메서드");
}
async function review() {
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "테스트 호출 검토" }));
  return screen.getByRole("dialog", { name: "실제 MCP 호출 검토" });
}
const confirm = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "검토한 호출 실행" });
async function phrase(dialog: HTMLElement) {
  await userEvent.type(within(dialog).getByLabelText(/확인 문구/), "실제 호출");
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    read: true,
    write: true,
    readonly: false,
    permitted: true,
    mounted: true,
  });
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("MCP 호출 검토", () => {
  it("확인 문구와 대상·인수를 검토한 뒤 최신 경로를 비교하고 한 번 실행한다", async () => {
    const { api } = setup();
    await userEvent.clear(screen.getByLabelText("JSON 인수"));
    await userEvent.paste('{"query":"공개 검색"}');
    const dialog = await review();
    expect(confirm(dialog)).toBeDisabled();
    expect(api.bodies(testKey)).toEqual([]);
    await phrase(dialog);
    await userEvent.dblClick(confirm(dialog));
    await screen.findByText("호출 성공");
    expect(api.bodies(explainKey)).toEqual([input, input]);
    expect(api.bodies(testKey)).toEqual([
      { ...input, upstream_id: "public-id", arguments: { query: "공개 검색" } },
    ]);
    expect(screen.getByRole("button", { name: "테스트 호출 검토" })).toBeDisabled();
    expect(
      api.spy.mock.calls.filter(([endpoint]) => endpoint.path === "/admin/mcp/test")[0]?.[1],
    ).toMatchObject({ retryUnauthorized: false });
  });
  it("취소·Escape는 실행하지 않고 검토 버튼으로 초점을 복원한다", async () => {
    const { api } = setup();
    await review();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "테스트 호출 검토" })).toHaveFocus();
    expect(api.bodies(testKey)).toEqual([]);
  });
  it("읽기 전용에서는 경로만 확인한다", async () => {
    runtime.readonly = true;
    const { api } = setup();
    await inspect();
    expect(screen.getByRole("button", { name: "테스트 호출 검토" })).toBeDisabled();
    expect(api.bodies(testKey)).toEqual([]);
  });
  it("서버의 경로 확인 권한이 없으면 POST하지 않는다", async () => {
    runtime.write = false;
    const { api } = setup();
    expect(screen.getByRole("button", { name: "적용 경로 확인" })).toBeDisabled();
    expect(api.bodies(explainKey)).toEqual([]);
  });
  it.each(["block", "approval_required", "future", "__proto__", "constructor"])(
    "%s 판단은 실제 호출하지 않는다",
    async (decision) => {
      const { api } = setup({ [explainKey]: () => ({ ...explanation, final: { decision, reason: "" } }) });
      await inspect();
      expect(screen.getByRole("button", { name: "테스트 호출 검토" })).toBeDisabled();
      expect(api.bodies(testKey)).toEqual([]);
    },
  );
  it("경로나 정책이 달라지면 전송 전에 중단한다", async () => {
    let reads = 0;
    const { api } = setup({
      [explainKey]: () =>
        ++reads === 1
          ? explanation
          : { ...explanation, route: { ...explanation.route, upstream_id: "other" } },
    });
    const dialog = await review();
    await phrase(dialog);
    await userEvent.click(confirm(dialog));
    await within(dialog).findByText(
      "경로 또는 정책 변경으로 실행하지 않았습니다. 창을 닫고 다시 검토하세요.",
    );
    expect(confirm(dialog)).toBeDisabled();
    expect(api.bodies(testKey)).toEqual([]);
  });
  it("응답을 잃어도 검토창에서 자동·즉시 재호출하지 않는다", async () => {
    const { api } = setup({
      [testKey]: () => {
        throw apiFailure("private upstream error", 503);
      },
    });
    const dialog = await review();
    await phrase(dialog);
    await userEvent.click(confirm(dialog));
    await within(dialog).findByText(
      "이미 호출을 전송했습니다. 외부 상태를 확인하기 전에는 재실행하지 마세요.",
    );
    expect(confirm(dialog)).toBeDisabled();
    expect(api.bodies(testKey)).toHaveLength(1);
    expect(screen.queryByText("private upstream error")).not.toBeInTheDocument();
  });
  it("검토 중 읽기 전용으로 바뀌면 확인 문구는 보존하고 실행만 막는다", async () => {
    const view = setup();
    const dialog = await review();
    await phrase(dialog);
    runtime.readonly = true;
    view.refresh();
    expect(within(dialog).getByLabelText(/확인 문구/)).toHaveValue("실제 호출");
    expect(confirm(dialog)).toBeDisabled();
    expect(view.api.bodies(testKey)).toEqual([]);
  });
  it.each(["id", "read", "write", "permitted", "mounted"] as const)(
    "실행 전 재조회 중 %s 변경은 늦은 호출을 차단한다",
    async (key) => {
      let reads = 0;
      const held = deferred<typeof explanation>();
      const view = setup({ [explainKey]: () => (++reads === 1 ? explanation : held.promise) });
      const dialog = await review();
      await phrase(dialog);
      await userEvent.click(confirm(dialog));
      await waitFor(() => expect(reads).toBe(2));
      if (key === "id") runtime.id = "public-b";
      else runtime[key] = false;
      view.refresh();
      await act(async () => held.resolve(explanation));
      expect(view.api.bodies(testKey)).toEqual([]);
      expect(notices.error).not.toHaveBeenCalled();
    },
  );
  it("실행 중 계정 전환 후 늦은 응답·알림을 표시하지 않는다", async () => {
    const held = deferred<typeof result>();
    const view = setup({ [testKey]: () => held.promise });
    const dialog = await review();
    await phrase(dialog);
    await userEvent.click(confirm(dialog));
    await waitFor(() => expect(view.api.bodies(testKey)).toHaveLength(1));
    runtime.id = "public-b";
    view.refresh();
    await act(async () => held.resolve(result));
    expect(screen.queryByText("호출 성공")).not.toBeInTheDocument();
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).not.toHaveBeenCalled();
  });
  it("입력이 바뀐 뒤 늦은 설명을 이전 결과로 표시하지 않는다", async () => {
    const held = deferred<typeof explanation>();
    setup({ [explainKey]: () => held.promise });
    await userEvent.type(screen.getByLabelText("노출 이름"), input.name);
    await userEvent.click(screen.getByRole("button", { name: "적용 경로 확인" }));
    await userEvent.type(screen.getByLabelText("노출 이름"), "-new");
    await act(async () => held.resolve(explanation));
    expect(screen.queryByText("확인한 메서드")).not.toBeInTheDocument();
    expect(notices.error).not.toHaveBeenCalled();
  });
  it("조회 실패를 빈 목록으로 표시하지 않는다", async () => {
    setup({
      "GET /admin/mcp/routes": () => {
        throw apiFailure("private", 503);
      },
    });
    await screen.findByRole("alert");
    expect(screen.queryByText("노출된 MCP 라우트가 없습니다.")).not.toBeInTheDocument();
  });
  it("새 경로 확인이 끝난 뒤 이전 실패 응답은 알림도 남기지 않는다", async () => {
    const held = deferred<typeof explanation>();
    let reads = 0;
    setup({
      [explainKey]: () =>
        ++reads === 1 ? held.promise : { ...explanation, input: { ...input, name: "public__next" } },
    });
    await userEvent.type(screen.getByLabelText("노출 이름"), input.name);
    await userEvent.click(screen.getByRole("button", { name: "적용 경로 확인" }));
    await userEvent.clear(screen.getByLabelText("노출 이름"));
    await userEvent.type(screen.getByLabelText("노출 이름"), "public__next");
    await userEvent.click(screen.getByRole("button", { name: "적용 경로 확인" }));
    await screen.findByText("확인한 메서드");
    await act(async () => held.resolve(explanation));
    expect(screen.getByText("public__next", { selector: "dd" })).toBeVisible();
    expect(notices.error).not.toHaveBeenCalled();
  });
  it("조회 403은 입력과 검토 결과를 지우고 수동 복구한다", async () => {
    let denied = false;
    const view = setup({
      "GET /admin/mcp/routes": () => {
        if (denied) throw apiFailure("denied", 403);
        return { routes: [], errors: {} };
      },
    });
    await inspect();
    denied = true;
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["mcp", "routes"] });
    });
    await screen.findByText("MCP 개요 조회 권한을 다시 확인하세요.");
    expect(screen.queryByText("확인한 메서드")).not.toBeInTheDocument();
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByLabelText("노출 이름")).toHaveValue("");
  });
  it("인증정보가 포함된 응답은 펼칠 수 없다", async () => {
    setup({ [testKey]: () => ({ ...result, response_preview: `custom_${"a".repeat(40)}` }) });
    const dialog = await review();
    await phrase(dialog);
    await userEvent.click(confirm(dialog));
    await screen.findByText("인증정보로 보이는 내용이 있어 응답 미리보기를 숨겼습니다.");
    expect(screen.queryByText(`custom_${"a".repeat(40)}`)).not.toBeInTheDocument();
  });
});

describe("MCP 호출 입력 계약", () => {
  it("정책 근거는 한글로 설명하고 알 수 없는 원문과 인증정보를 구분한다", () => {
    expect(callReason(explanation.final.reason, [])).toBe("경로를 찾았고 현재 정책이 호출을 허용합니다.");
    expect(callReason("__proto__", [])).toBe("__proto__");
    expect(callReason(`custom_${"a".repeat(40)}`, ["custom_"])).toBe(
      "인증정보로 보이는 내용이 있어 근거 원문을 숨겼습니다.",
    );
  });
  it.each(["[]", "null", "true", "{broken", JSON.stringify({ q: "가".repeat(6000) }), '{"token":"private"}'])(
    "잘못된 인수 %#를 거부한다",
    (raw) => {
      expect(() => callCommand({ ...emptyCall, name: input.name, arguments: raw }, ["custom_"])).toThrow();
    },
  );
  it("리소스와 목록 점검은 숨겨진 이름·URI·인수를 보내지 않는다", () => {
    expect(
      callCommand(
        { ...emptyCall, method: "resources/read", uri: "mcp://public", name: "old", arguments: "invalid" },
        [],
      ),
    ).toEqual({ input: { method: "resources/read", name: "", uri: "mcp://public" }, arguments: {} });
    expect(
      callCommand(
        { ...emptyCall, method: "tools/list", name: input.name, uri: "old", arguments: "invalid" },
        [],
      ).arguments,
    ).toEqual({});
  });
  it.each([
    {},
    { ...explanation, input: { ...input, name: "other" } },
    { ...explanation, route: { found: true } },
  ])("불완전·다른 입력의 응답을 거부한다 %#", (value) => {
    expect(() => checkedExplanation(value, input)).toThrow();
  });
  it("경로 없음은 허용으로 취급하지 않는다", () => {
    expect(
      callable(
        checkedExplanation(
          { input, route: { found: false }, final: { decision: "block", reason: "missing" } },
          input,
        ),
      ),
    ).toBe(false);
  });
});
