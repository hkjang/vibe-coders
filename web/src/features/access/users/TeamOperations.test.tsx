import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { TeamsTab } from "./TeamsTab";
import { teamAdministrationSchema } from "@/shared/api/domains/access.schemas";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "operator_a", role: "admin", write: true, readOnly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: runtime.role,
        user: { id: runtime.id, team_id: "team_a" },
        scopes: runtime.write ? ["admin:read", "admin:write"] : ["admin:read"],
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  Object.assign(runtime, { id: "operator_a", role: "admin", write: true, readOnly: false });
  vi.clearAllMocks();
});
const team = {
  id: "team_a",
  name: "첫 팀",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const catalog = { teams: [], auth_teams: [team] };
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/teams": () => catalog,
    "GET /admin/teams/scorecard": () => ({ teams: [] }),
    "GET /admin/benchmark/teams": () => ({ teams: [] }),
    "POST /admin/teams": () => ({ team }),
    ...handlers,
  });
  let update = () => undefined;
  function Host() {
    const [, force] = useReducer((n) => n + 1, 0);
    update = () => {
      force();
      return undefined;
    };
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "access.users", permitted: true, readOnly: runtime.readOnly }}
      >
        <TeamsTab canWrite writeDeniedReason="변경 권한 없음" />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, view, update: () => act(() => update()) };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function edit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "이름 수정" }));
  return within(await screen.findByRole("dialog", { name: "팀 이름 수정" }));
}
describe("팀 생성과 이름 수정", () => {
  it("생성은 명시적인 새 ID를 제안하고 기존 ID를 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(await screen.findByRole("button", { name: "팀 추가" }));
    const dialog = within(await screen.findByRole("dialog", { name: "팀 추가" }));
    const id = dialog.getByLabelText("팀 ID", { exact: false });
    const proposed = (id as HTMLInputElement).value;
    expect(proposed).toMatch(/^team_[a-f0-9]{32}$/u);
    await user.type(dialog.getByLabelText("팀 이름", { exact: false }), "새 팀");
    expect(id).toHaveValue(proposed);
    await user.clear(id);
    await user.type(id, team.id);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("이미 등록된 팀 ID");
    expect(api.bodies("POST /admin/teams")).toEqual([]);
    await user.clear(id);
    await user.type(id, proposed);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/teams")).toEqual([{ id: proposed, name: "새 팀" }]);
    expect(screen.getByRole("button", { name: "팀 추가" })).toHaveFocus();
  });
  it("기존 ID는 읽기 전용이며 비교한 이름만 저장한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await edit(user);
    expect(dialog.getByLabelText("팀 ID", { exact: false })).toHaveAttribute("readonly");
    await user.clear(dialog.getByLabelText("팀 이름", { exact: false }));
    await user.type(dialog.getByLabelText("팀 이름", { exact: false }), " 변경 팀 ");
    expect(dialog.getByRole("region", { name: "팀 변경 전후 비교" })).toHaveTextContent(
      "변경 전 이름: 첫 팀",
    );
    expect(dialog.getByRole("region", { name: "팀 변경 전후 비교" })).toHaveTextContent(
      "변경 후 이름: 변경 팀",
    );
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/teams")).toEqual([{ id: team.id, name: "변경 팀" }]);
    expect(screen.getByRole("button", { name: "이름 수정" })).toHaveFocus();
    expect(api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST")?.[1]).toMatchObject({
      retryUnauthorized: false,
    });
  });
  it("저장 전 서버에서 변경된 팀은 이전 초안으로 덮어쓰지 않는다", async () => {
    let reads = 0;
    const user = userEvent.setup();
    const { api } = setup({
      "GET /admin/teams": () =>
        ++reads === 1 ? catalog : { ...catalog, auth_teams: [{ ...team, name: "서버의 새 이름" }] },
    });
    const dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("팀이 변경되었거나 없어졌습니다");
    expect(dialog.getByLabelText("팀 이름", { exact: false })).toHaveValue(team.name);
    expect(api.bodies("POST /admin/teams")).toEqual([]);
  });
  it("팀 관리자는 새 팀 생성 없이 소속 팀 이름만 바꾼다", async () => {
    runtime.role = "team_admin";
    runtime.write = false;
    const user = userEvent.setup();
    const { api } = setup();
    expect(await screen.findByRole("button", { name: "팀 추가" })).toBeDisabled();
    const dialog = await edit(user);
    await user.type(dialog.getByLabelText("팀 이름", { exact: false }), " 수정");
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/teams")).toEqual([{ id: team.id, name: "첫 팀 수정" }]),
    );
  });
  for (const change of ["readonly", "scope"] as const) {
    it(`${change} 회수는 열린 초안을 보존하며 저장을 막는다`, async () => {
      const user = userEvent.setup();
      const { api, update } = setup();
      const dialog = await edit(user);
      await user.type(dialog.getByLabelText("팀 이름", { exact: false }), " 초안");
      if (change === "readonly") runtime.readOnly = true;
      else runtime.write = false;
      update();
      expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
      expect(dialog.getByLabelText("팀 이름", { exact: false })).toHaveValue("첫 팀 초안");
      expect(api.bodies("POST /admin/teams")).toEqual([]);
    });
    it(`${change} 회수 뒤 이전 성공은 알림·갱신·닫기를 하지 않는다`, async () => {
      const held = deferred();
      const user = userEvent.setup();
      const { api, update } = setup({ "POST /admin/teams": () => held.promise });
      const dialog = await edit(user);
      await user.click(dialog.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(api.bodies("POST /admin/teams")).toHaveLength(1));
      if (change === "readonly") runtime.readOnly = true;
      else runtime.write = false;
      update();
      const reads = api.calls.filter((call) => call.key === "GET /admin/teams").length;
      await act(async () => held.resolve({ team }));
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(toast.success).not.toHaveBeenCalled();
      expect(api.calls.filter((call) => call.key === "GET /admin/teams")).toHaveLength(reads);
    });
  }
  it("계정 변경은 이전 팀 목록과 초안을 폐기한다", async () => {
    const user = userEvent.setup();
    const { update } = setup({
      "GET /admin/teams": () => (runtime.id === "operator_a" ? catalog : { teams: [], auth_teams: [] }),
    });
    await edit(user);
    runtime.id = "operator_b";
    update();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(team.name)).not.toBeInTheDocument());
  });
  it("조회 권한 오류는 보관된 팀과 초안을 숨긴다", async () => {
    let reads = 0;
    const user = userEvent.setup();
    const { api } = setup({
      "GET /admin/teams": () => {
        if (++reads > 1) throw apiFailure("private failure", 403);
        return catalog;
      },
    });
    const dialog = await edit(user);
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("팀 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(team.name)).not.toBeInTheDocument();
    expect(api.bodies("POST /admin/teams")).toEqual([]);
  });
  it.each([{}, { auth_teams: null }, { auth_teams: [team, team] }, { auth_teams: [{ id: "team_a" }] }])(
    "불완전한 등록 목록을 빈 목록으로 해석하지 않는다 (%#)",
    (value) => {
      expect(teamAdministrationSchema.safeParse(value).success).toBe(false);
    },
  );
  it("정상적인 빈 등록 목록은 허용한다", () => {
    expect(teamAdministrationSchema.safeParse({ auth_teams: [] }).success).toBe(true);
  });
  it("팀 관리자는 다른 팀 행이 있어도 수정 버튼을 사용할 수 없다", async () => {
    runtime.role = "team_admin";
    runtime.write = false;
    setup({
      "GET /admin/teams": () => ({
        teams: [],
        auth_teams: [team, { ...team, id: "team_b", name: "다른 팀" }],
      }),
    });
    const row = (await screen.findByText("다른 팀")).closest("tr");
    if (!row) throw new Error("팀 행 없음");
    expect(within(row).getByRole("button", { name: "이름 수정" })).toBeDisabled();
  });
  it("같은 계정의 화면 재생성도 진행 중인 변경을 중복 전송하지 않는다", async () => {
    const held = deferred();
    const user = userEvent.setup();
    const { api, update } = setup({ "POST /admin/teams": () => held.promise });
    const first = await edit(user);
    await user.click(first.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.bodies("POST /admin/teams")).toHaveLength(1));
    runtime.role = "ops_admin";
    update();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const next = await edit(user);
    await user.click(next.getByRole("button", { name: "저장" }));
    expect(await next.findByRole("alert")).toHaveTextContent("팀 변경을 처리 중입니다");
    expect(api.bodies("POST /admin/teams")).toHaveLength(1);
    await act(async () => held.resolve({ team }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
