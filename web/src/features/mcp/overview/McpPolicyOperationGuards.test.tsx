import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPolicyTab } from "./McpPolicyTab";
import { mcpPolicyListSchema } from "@/shared/api/domains/mcp.schemas";
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
    useAuth: () =>
      testAuth({
        user: { id: runtime.id },
        scopes: [...(runtime.read ? ["observability:read"] : []), ...(runtime.write ? ["mcp:admin"] : [])],
      }),
  };
});
const row = {
  server_label: "public server",
  mode: "block",
  note: "원래 메모",
  created_at: "2026-10-14T00:00:00Z",
  updated_at: "2026-10-14T00:00:00Z",
};
const snapshot = { policies: [row], allowlist_enabled: false };
const list = "GET /admin/mcp/policies";
const post = "POST /admin/mcp/policies";
const remove = "DELETE /admin/mcp/policies/public%20server";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    [list]: () => snapshot,
    "GET /admin/mcp/loops": () => ({ loops: [] }),
    [post]: () => ({ policy: row }),
    [remove]: () => ({ status: "deleted" }),
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
        {runtime.mounted ? <McpPolicyTab canWrite={runtime.write} /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Harness />, { route: "/mcp?tab=policy", path: "/mcp" });
  return { ...view, api, refresh: () => act(() => refresh()) };
}
async function open(kind: "save" | "create" | "delete" | "allowlist" = "save") {
  const names = {
    save: "public server 정책 편집",
    create: "정책 추가",
    delete: "public server 정책 삭제",
    allowlist: "허용목록 변경 검토",
  };
  const button = await screen.findByRole("button", { name: names[kind] });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  return screen.getByRole("dialog");
}
async function change(dialog: HTMLElement) {
  await userEvent.clear(within(dialog).getByLabelText("메모"));
  await userEvent.type(within(dialog).getByLabelText("메모"), "새 메모");
}
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "검토한 정책 저장" });
const writes = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => call.key === post || call.key === remove);
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

describe("MCP 정책 변경 검토", () => {
  it("변경 없는 편집은 저장하지 않고 명시적인 메모 삭제를 비교한다", async () => {
    const { api } = setup();
    const dialog = await open();
    expect(save(dialog)).toBeDisabled();
    expect(within(dialog).getByLabelText(/서버 라벨/)).toHaveAttribute("readonly");
    await userEvent.clear(within(dialog).getByLabelText("메모"));
    expect(within(dialog).getByText("변경 후: 없음", { exact: false })).toBeVisible();
    await userEvent.click(save(dialog));
    await waitFor(() =>
      expect(api.bodies(post)).toEqual([{ server_label: row.server_label, mode: "block", note: "" }]),
    );
    expect(api.calls.filter((call) => call.key === list)).toHaveLength(3);
  });
  it("정책 추가로 기존 서버를 덮어쓰지 않는다", async () => {
    const { api } = setup();
    const dialog = await open("create");
    await userEvent.type(within(dialog).getByLabelText(/서버 라벨/), row.server_label);
    expect(within(dialog).getByText(/이미 등록된 서버 정책/)).toBeVisible();
    expect(save(dialog)).toBeDisabled();
    expect(writes(api)).toHaveLength(0);
  });
  it("새 정책을 명시적으로 검토한 뒤 기존 API로 한 번 저장한다", async () => {
    const { api } = setup();
    const dialog = await open("create");
    await userEvent.type(within(dialog).getByLabelText(/서버 라벨/), "public-new");
    await userEvent.selectOptions(within(dialog).getByLabelText(/모드/), "warn");
    await userEvent.dblClick(save(dialog));
    await waitFor(() =>
      expect(api.bodies(post)).toEqual([{ server_label: "public-new", mode: "warn", note: "" }]),
    );
  });
  it("알 수 없는 모드를 자동 허용하지 않고 명시적 선택을 요구한다", async () => {
    setup({ [list]: () => ({ ...snapshot, policies: [{ ...row, mode: "future" }] }) });
    const dialog = await open();
    expect(within(dialog).getByLabelText(/모드/)).toHaveValue("future");
    await change(dialog);
    expect(save(dialog)).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText(/모드/), "block");
    expect(save(dialog)).toBeEnabled();
  });
  it("허용목록 변경은 즉시 전송하지 않고 대상 문구와 영향을 확인한다", async () => {
    const { api } = setup();
    const dialog = await open("allowlist");
    expect(writes(api)).toHaveLength(0);
    const apply = within(dialog).getByRole("button", { name: "검토한 모드 적용" });
    expect(apply).toBeDisabled();
    expect(within(dialog).getByText(/등록되지 않은 서버를 차단/)).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText(/확인 문구/), "허용목록 사용");
    await userEvent.click(apply);
    await waitFor(() => expect(api.bodies(post)).toEqual([{ allowlist_enabled: true }]));
  });
  it("삭제 후 기본 허용을 안내하고 정확한 서버 문구가 있어야 삭제한다", async () => {
    const { api } = setup();
    const dialog = await open("delete");
    expect(within(dialog).getByText(/삭제 후: 미등록 · 서버 기본 허용/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/확인 문구/), row.server_label);
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(api.calls.filter((call) => call.key === remove)).toHaveLength(1));
  });
  it.each(["readonly", "write"] as const)("%s 변경은 초안을 보존하고 저장을 차단한다", async (key) => {
    const view = setup();
    const dialog = await open();
    await change(dialog);
    if (key === "readonly") runtime.readonly = true;
    else runtime.write = false;
    view.refresh();
    expect(within(dialog).getByLabelText("메모")).toHaveValue("새 메모");
    expect(save(dialog)).toBeDisabled();
    act(() =>
      dialog.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(writes(view.api)).toHaveLength(0);
  });
  it.each(["mode", "note", "updated_at", "extra", "allowlist"])(
    "사전 조회에서 %s 변경을 발견하면 저장을 막는다",
    async (field) => {
      let changed = false;
      const view = setup({
        [list]: () =>
          !changed
            ? snapshot
            : field === "allowlist"
              ? { ...snapshot, allowlist_enabled: true }
              : { ...snapshot, policies: [{ ...row, [field]: "changed" }] },
      });
      const dialog = await open();
      await change(dialog);
      changed = true;
      await userEvent.click(save(dialog));
      expect(await within(dialog).findByText("현재 설정을 다시 확인하세요.")).toBeVisible();
      expect(writes(view.api)).toHaveLength(0);
      expect(within(dialog).getByLabelText("메모")).toHaveValue("새 메모");
    },
  );
  it("다른 관리자가 같은 이름을 추가하면 신규 등록을 중단한다", async () => {
    let changed = false;
    const { api } = setup({
      [list]: () =>
        changed
          ? { ...snapshot, policies: [...snapshot.policies, { ...row, server_label: "public-new" }] }
          : snapshot,
    });
    const dialog = await open("create");
    await userEvent.type(within(dialog).getByLabelText(/서버 라벨/), "public-new");
    changed = true;
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText("현재 설정을 다시 확인하세요.")).toBeVisible();
    expect(writes(api)).toHaveLength(0);
  });
  it("허용목록 검토 후 등록 서버 목록이 바뀌면 적용을 막는다", async () => {
    let changed = false;
    const { api } = setup({ [list]: () => ({ ...snapshot, policies: changed ? [] : [row] }) });
    const dialog = await open("allowlist");
    await userEvent.type(within(dialog).getByLabelText(/확인 문구/), "허용목록 사용");
    changed = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "검토한 모드 적용" }));
    expect(await within(dialog).findByText("현재 설정을 다시 확인하세요.")).toBeVisible();
    expect(writes(api)).toHaveLength(0);
  });
  it("사전 조회 중 쓰기 권한이 회수되면 POST를 전송하지 않는다", async () => {
    const held = deferred<typeof snapshot>();
    let reads = 0;
    const view = setup({ [list]: () => (++reads === 1 ? snapshot : held.promise) });
    const dialog = await open();
    await change(dialog);
    await userEvent.click(save(dialog));
    await waitFor(() => expect(reads).toBe(2));
    runtime.write = false;
    view.refresh();
    await act(async () => held.resolve(snapshot));
    expect(writes(view.api)).toHaveLength(0);
  });
  it.each([401, 403])("사전 조회 %i는 목록·초안을 폐기한다", async (status) => {
    let reads = 0;
    const { api } = setup({
      [list]: () => {
        if (++reads > 1) throw apiFailure("denied", status);
        return snapshot;
      },
    });
    const dialog = await open();
    await change(dialog);
    await userEvent.click(save(dialog));
    expect(await screen.findByText("MCP 정책 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(api)).toHaveLength(0);
  });
  it.each(["id", "read", "permitted", "mounted"] as const)(
    "%s 변경 후 이전 작업의 완료를 알리지 않는다",
    async (key) => {
      const held = deferred<object>();
      const view = setup({ [post]: () => held.promise });
      const dialog = await open();
      await change(dialog);
      await userEvent.click(save(dialog));
      await waitFor(() => expect(writes(view.api)).toHaveLength(1));
      if (key === "id") runtime.id = "public-b";
      else runtime[key] = false;
      view.refresh();
      await act(async () => held.resolve({ policy: row }));
      expect(notices.success).not.toHaveBeenCalled();
      expect(notices.error).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it("화면 재생성 후에도 같은 계정의 진행 중 변경과 겹쳐 전송하지 않는다", async () => {
    const held = deferred<object>();
    const view = setup({ [post]: () => held.promise });
    const dialog = await open();
    await change(dialog);
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(view.api)).toHaveLength(1));
    runtime.mounted = false;
    view.refresh();
    runtime.mounted = true;
    view.refresh();
    const next = await open("allowlist");
    await userEvent.type(within(next).getByLabelText(/확인 문구/), "허용목록 사용");
    await userEvent.click(within(next).getByRole("button", { name: "검토한 모드 적용" }));
    await waitFor(() => expect(notices.error).toHaveBeenCalled());
    expect(writes(view.api)).toHaveLength(1);
    await act(async () => held.resolve({ policy: row }));
    expect(notices.success).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])("저장 %i를 자동 재전송하지 않고 요청 ID를 표시한다", async (status) => {
    const { api } = setup({
      [post]: () => {
        throw apiFailure("failed", status, "public-policy-error");
      },
    });
    const dialog = await open();
    await change(dialog);
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText(/요청 ID: public-policy-error/)).toBeVisible();
    expect(writes(api)).toHaveLength(1);
    const call = api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST");
    expect(call?.[1]?.retryUnauthorized).toBe(false);
  });
  it("초기 목록 실패를 빈 정책이나 변경 가능한 상태로 보이지 않는다", async () => {
    setup({
      [list]: () => {
        throw apiFailure("unavailable");
      },
    });
    expect(await screen.findByText("MCP 정책 조회에 실패했습니다.")).toBeVisible();
    expect(screen.queryByText("등록된 서버 정책이 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "허용목록 변경 검토" })).toBeDisabled();
  });
  it("조회 권한 없이 정책 API를 호출하지 않는다", async () => {
    runtime.read = false;
    const { api } = setup();
    expect(await screen.findByText(/필요 권한: observability:read/)).toBeVisible();
    expect(api.calls).toHaveLength(0);
  });
});

describe("정책 읽기 계약", () => {
  it.each([
    {},
    { policies: [] },
    { allowlist_enabled: false },
    { policies: null, allowlist_enabled: false },
    { policies: [], allowlist_enabled: "false" },
    { ...snapshot, policies: [row, row] },
    { ...snapshot, policies: [{ ...row, mode: null }] },
  ])("누락·잘못된 설정을 안전한 기본값으로 바꾸지 않는다", (value) => {
    expect(mcpPolicyListSchema.safeParse(value).success).toBe(false);
  });
  it("미래 모드·추가 필드를 보존하면서 현재 계약을 검증한다", () => {
    const value = { ...snapshot, policies: [{ ...row, mode: "future", extra: { v: 1 } }] };
    expect(mcpPolicyListSchema.parse(value)).toEqual(value);
  });
});
