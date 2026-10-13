import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { UsersTab } from "./UsersTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "operator_a",
  role: "admin",
  read: true,
  write: true,
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({
        role: runtime.role,
        user: { id: runtime.id },
        scopes: [...(runtime.read ? ["admin:read"] : []), ...(runtime.write ? ["admin:write"] : [])],
      }),
      credentialPrefixes: ["vc_sk_", "corp_"],
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  Object.assign(runtime, { id: "operator_a", role: "admin", read: true, write: true, readOnly: false });
  vi.clearAllMocks();
});
const row = {
  api_key_id: "key_external",
  name: "외부 사용 키",
  owner: "사용자 A",
  team: "팀 A",
  status: "external",
  requests: 12,
  tokens: 100,
  cost_krw: 5,
  average_latency_ms: 20,
  last_seen: "2026-10-01T00:00:00Z",
};
const catalog = {
  users: [row],
  auth_users: [
    {
      id: "usr_a",
      email: "a@example.invalid",
      name: "계정 A",
      role: "developer",
      status: "active",
      team_id: "team_a",
      created_at: "2026-10-01T00:00:00Z",
    },
  ],
  team_names: {},
};
const detail = {
  api_key: { name: "키 상세 A" },
  by_model: [],
  by_ip: [],
  by_language: [],
  daily: [],
  recent: [],
};
const report = {
  requests: 12,
  error_requests: 0,
  error_rate: 0,
  cost_krw: 5,
  average_latency_ms: 20,
  sessions: 1,
  average_session_seconds: 10,
  work_seconds: 10,
  top_models: [],
};
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/users": () => catalog,
    "GET /admin/benchmark/users": () => ({ users: [] }),
    "GET /admin/users/key_external": () => detail,
    "GET /admin/users/key_external/report": () => report,
    "GET /admin/roles": () => ({ roles: [{ role: "developer", scopes: [] }] }),
    "PATCH /admin/api-keys/key_external": () => ({ id: "key_external" }),
    ...handlers,
  });
  let update = () => {};
  function Host() {
    const [, force] = useReducer((n) => n + 1, 0);
    update = force;
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "access.users", permitted: true, readOnly: runtime.readOnly }}
      >
        <UsersTab canWrite writeDeniedReason="변경 권한 없음" />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, view, update: () => act(() => update()) };
}
async function openPromotion(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "관리 키로 등록" }));
  return within(await screen.findByRole("dialog", { name: "관리 키로 등록" }));
}
describe("사용자 화면 조회·작업 수명", () => {
  it("상세 조회만 실패하면 수동 재시도 중 버튼을 잠그고 정상 목록과 리포트를 유지한다", async () => {
    let reads = 0;
    const held = deferred();
    const user = userEvent.setup();
    const { api } = setup({
      "GET /admin/users/key_external": () => {
        if (++reads === 1) throw apiFailure("private failure");
        return held.promise;
      },
    });
    await user.click(await screen.findByRole("button", { name: "외부 사용 키 상세 열기" }));
    expect(await screen.findByText("사용자 상세를 불러오지 못했습니다.")).toBeVisible();
    const retry = screen.getByRole("button", { name: "다시 조회" });
    await user.click(retry);
    expect(retry).toBeDisabled();
    await act(async () => held.resolve(detail));
    expect(await screen.findByRole("dialog", { name: "키 상세 A" })).toBeVisible();
    expect(screen.queryByText("사용자 상세를 불러오지 못했습니다.")).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.key === "GET /admin/users")).toHaveLength(1);
    expect(api.calls.filter((call) => call.key === "GET /admin/users/key_external/report")).toHaveLength(1);
  });
  it("활동 리포트 장애는 상세와 별개로 다시 조회한다", async () => {
    let reads = 0;
    const user = userEvent.setup();
    const { api } = setup({
      "GET /admin/users/key_external/report": () => {
        if (++reads === 1) throw apiFailure("private failure");
        return report;
      },
    });
    await user.click(await screen.findByRole("button", { name: "외부 사용 키 상세 열기" }));
    expect(await screen.findByText("활동 리포트를 불러오지 못했습니다.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "리포트 다시 조회" }));
    await waitFor(() =>
      expect(screen.queryByText("활동 리포트를 불러오지 못했습니다.")).not.toBeInTheDocument(),
    );
    expect(api.calls.filter((call) => call.key === "GET /admin/users/key_external")).toHaveLength(1);
    expect(api.calls.filter((call) => call.key === "GET /admin/users/key_external/report")).toHaveLength(2);
  });
  it("첫 목록 장애를 0건·정상 빈 목록으로 표시하지 않고 다시 조회한다", async () => {
    let reads = 0;
    const user = userEvent.setup();
    setup({
      "GET /admin/users": () => {
        if (++reads === 1) throw apiFailure("private failure");
        return catalog;
      },
    });
    expect(await screen.findByText("사용자 목록을(를) 불러오지 못했습니다.")).toBeVisible();
    expect(screen.queryByRole("table", { name: "로그인 계정 목록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "사용자 등록" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("a@example.invalid")).toBeVisible();
  });
  it("현재 서버의 자격정보 접두사를 검색에 적용한다", async () => {
    const user = userEvent.setup();
    setup();
    const input = await screen.findByRole("textbox", { name: "검색" });
    await user.type(input, `corp_${"A".repeat(43)}`);
    expect(input).not.toHaveValue(`corp_${"A".repeat(43)}`);
    expect(screen.getByText(/인증정보로 보이는 검색어/)).toBeVisible();
  });
  it("계정 교체는 이전 목록·검색·확인창을 폐기하고 새 조회를 기다린다", async () => {
    const held = deferred();
    const user = userEvent.setup();
    const { update } = setup({
      "GET /admin/users": () => (runtime.id === "operator_a" ? catalog : held.promise),
    });
    await openPromotion(user);
    runtime.id = "operator_b";
    update();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("a@example.invalid")).not.toBeInTheDocument();
    expect(screen.getByText("사용자 목록을 불러오는 중입니다.")).toBeVisible();
    await act(async () => held.resolve({ users: [], auth_users: [], team_names: {} }));
    expect(await screen.findByRole("textbox", { name: "검색" })).toHaveValue("");
  });
  it("조회 스코프 회수는 목록·초안·소유 캐시를 폐기한다", async () => {
    const user = userEvent.setup();
    const { update, view } = setup();
    await user.click(await screen.findByRole("button", { name: "사용자 등록" }));
    expect(await screen.findByRole("dialog", { name: "사용자 등록" })).toBeVisible();
    runtime.read = false;
    update();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("a@example.invalid")).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey.includes("user-administration")),
    ).toHaveLength(0);
  });
  for (const endpoint of [
    "GET /admin/benchmark/users",
    "GET /admin/users/key_external",
    "GET /admin/users/key_external/report",
  ]) {
    it(`${endpoint} 권한 오류는 연결된 이전 계정·상세를 숨긴다`, async () => {
      const held = deferred();
      const user = userEvent.setup();
      setup({ [endpoint]: () => held.promise });
      expect(await screen.findByText("a@example.invalid")).toBeVisible();
      if (endpoint !== "GET /admin/benchmark/users")
        await user.click(screen.getByRole("button", { name: "외부 사용 키 상세 열기" }));
      await act(async () => held.reject(apiFailure("private failure", 403)));
      expect(await screen.findByText("사용자 조회 권한을 다시 확인하세요.")).toBeVisible();
      expect(screen.queryByText("a@example.invalid")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  }
  for (const kind of ["readonly", "scope"] as const) {
    it(`${kind} 회수 시 열린 키 등록 확인을 비활성화한다`, async () => {
      const user = userEvent.setup();
      const { api, update } = setup();
      const dialog = await openPromotion(user);
      if (kind === "readonly") runtime.readOnly = true;
      else runtime.write = false;
      update();
      expect(dialog.getByRole("button", { name: "등록" })).toBeDisabled();
      expect(api.bodies("PATCH /admin/api-keys/key_external")).toHaveLength(0);
    });
    for (const failed of [false, true]) {
      it(`${kind} 회수 뒤 늦은 ${failed ? "실패" : "성공"}는 알림·조회 갱신·창 닫기를 하지 않는다`, async () => {
        const held = deferred();
        const user = userEvent.setup();
        const { api, update } = setup({ "PATCH /admin/api-keys/key_external": () => held.promise });
        const dialog = await openPromotion(user);
        await user.click(dialog.getByRole("button", { name: "등록" }));
        await waitFor(() => expect(api.bodies("PATCH /admin/api-keys/key_external")).toHaveLength(1));
        if (kind === "readonly") runtime.readOnly = true;
        else runtime.write = false;
        update();
        const reads = api.calls.filter((c) => c.key === "GET /admin/users").length;
        await act(async () => {
          if (failed) held.reject(apiFailure("private failure"));
          else held.resolve({ id: row.api_key_id });
        });
        expect(screen.getByRole("dialog", { name: "관리 키로 등록" })).toBeVisible();
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        expect(api.calls.filter((c) => c.key === "GET /admin/users")).toHaveLength(reads);
      });
    }
  }
  it("같은 계정의 화면 수명이 바뀌어도 진행 중 등록을 중복 전송하지 않는다", async () => {
    const held = deferred();
    const user = userEvent.setup();
    const { api, update } = setup({ "PATCH /admin/api-keys/key_external": () => held.promise });
    let dialog = await openPromotion(user);
    await user.click(dialog.getByRole("button", { name: "등록" }));
    await waitFor(() => expect(api.bodies("PATCH /admin/api-keys/key_external")).toHaveLength(1));
    runtime.role = "ops_admin";
    update();
    dialog = await openPromotion(user);
    await user.click(dialog.getByRole("button", { name: "등록" }));
    expect(await dialog.findByRole("alert")).toBeVisible();
    expect(api.bodies("PATCH /admin/api-keys/key_external")).toHaveLength(1);
    await act(async () => held.resolve({ id: row.api_key_id }));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
