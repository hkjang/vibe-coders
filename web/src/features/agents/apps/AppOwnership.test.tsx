import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppPage } from "./AppPage";
import { deferred, dialogForm } from "./app-permission-test-support";
import { toast } from "sonner";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "one", team: "team-one", scopes: ["admin:read", "admin:write"] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
  };
});
const first = { id: "first", title: "첫 계정 앱", status: "active", components: [] };
function Host() {
  const [readOnly, setReadOnly] = useState(false);
  const [, refresh] = useState(0);
  return (
    <FeatureAccessContext.Provider
      value={{ featureId: "agents.apps", permitted: true, readOnly, status: "preview" }}
    >
      <button
        onClick={() => {
          runtime.id = "two";
          refresh((n) => n + 1);
        }}
      >
        계정 변경
      </button>
      <button onClick={() => setReadOnly(true)}>읽기 전용 전환</button>
      <button
        onClick={() => {
          runtime.team = "team-two";
          refresh((n) => n + 1);
        }}
      >
        팀 변경
      </button>
      <button
        onClick={() => {
          runtime.scopes = [];
          refresh((n) => n + 1);
        }}
      >
        조회 권한 회수
      </button>
      <button
        onClick={() => {
          runtime.scopes = ["admin:read"];
          refresh((n) => n + 1);
        }}
      >
        쓰기 권한 회수
      </button>
      <AppPage />
    </FeatureAccessContext.Provider>
  );
}
const setup = () => renderScreen(<Host />, { path: "/agents/apps", route: "/agents/apps" });
beforeEach(() => {
  runtime.id = "one";
  runtime.team = "team-one";
  runtime.scopes = ["admin:read", "admin:write"];
  vi.clearAllMocks();
});
describe("업무 앱 조회·변경의 계정 경계", () => {
  it("발행 후 열려 있는 현재 계정의 버전 이력을 갱신한다", async () => {
    let version = 1;
    const api = mockApi({
      "GET /admin/apps": () => ({ apps: [first] }),
      "GET /admin/apps/first/versions": () => ({ versions: [{ version, note: `발행 기록 ${version}` }] }),
      "POST /admin/apps/first/publish": () => ({ version: ++version }),
    });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "첫 계정 앱 상세 열기" }));
    const sheet = screen.getByRole("dialog", { name: first.title });
    await user.click(within(sheet).getByRole("button", { name: "버전 이력" }));
    await within(sheet).findByText("발행 기록 1");
    await user.click(within(sheet).getByRole("button", { name: "발행" }));
    const confirm = await screen.findByRole("dialog", { name: "업무 앱 발행" });
    await user.type(within(confirm).getByRole("textbox"), "신규 정의 발행");
    await user.click(within(confirm).getByRole("button", { name: "발행" }));
    expect(await within(sheet).findByText("발행 기록 2")).toBeVisible();
    expect(api.calls.filter((c) => c.key === "GET /admin/apps/first/versions")).toHaveLength(2);
  });
  it("계정 변경 시 이전 목록을 재사용하지 않고 다시 조회한다", async () => {
    mockApi({
      "GET /admin/apps": () => ({
        apps: [{ ...first, title: runtime.id === "one" ? first.title : "두 번째 계정 앱" }],
      }),
    });
    const user = userEvent.setup();
    setup();
    await screen.findByRole("button", { name: "첫 계정 앱 상세 열기" });
    await user.click(screen.getByRole("button", { name: "계정 변경" }));
    expect(await screen.findByRole("button", { name: "두 번째 계정 앱 상세 열기" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "첫 계정 앱 상세 열기" })).not.toBeInTheDocument();
  });
  it("목록 갱신의 403은 이전 목록도 숨긴다", async () => {
    let denied = false;
    mockApi({
      "GET /admin/apps": () => {
        if (denied) throw apiFailure("denied", 403);
        return { apps: [first] };
      },
    });
    const user = userEvent.setup();
    setup();
    await screen.findByRole("button", { name: "첫 계정 앱 상세 열기" });
    denied = true;
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "첫 계정 앱 상세 열기" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("업무 앱 조회 권한을 다시 확인하세요.")).toBeVisible();
  });
  it.each(["읽기 전용 전환", "쓰기 권한 회수"])("%s 시 초안을 보존하고 제출을 막는다", async (action) => {
    const api = mockApi({ "GET /admin/apps": () => ({ apps: [first] }), "POST /admin/apps": () => first });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "새 업무 앱" }));
    const dialog = await screen.findByRole("dialog", { name: "새 AI 업무 앱" });
    await user.type(within(dialog).getByRole("textbox", { name: /제목/u }), "보존할 초안");
    await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다." }));
    expect(within(dialog).getByRole("button", { name: "앱 만들기" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: action, hidden: true }));
    expect(within(dialog).getByRole("textbox", { name: /제목/u })).toHaveValue("보존할 초안");
    expect(within(dialog).getByRole("button", { name: "앱 만들기" })).toBeDisabled();
    fireEvent.submit(dialogForm(dialog));
    await act(async () => undefined);
    expect(api.bodies("POST /admin/apps")).toEqual([]);
  });
  it("계정 변경은 이전 초안을 폐기한다", async () => {
    mockApi({ "GET /admin/apps": () => ({ apps: [first] }) });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "새 업무 앱" }));
    await screen.findByRole("dialog", { name: "새 AI 업무 앱" });
    fireEvent.click(screen.getByRole("button", { name: "계정 변경", hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "새 AI 업무 앱" })).not.toBeInTheDocument(),
    );
  });
  it.each(["계정 변경", "팀 변경", "조회 권한 회수"])(
    "%s 이후 늦은 목록은 캐시나 화면에 남지 않는다",
    async (action) => {
      const held = deferred();
      let calls = 0;
      mockApi({ "GET /admin/apps": () => (++calls === 1 ? held.promise : { apps: [] }) });
      const { client } = setup();
      await waitFor(() => expect(calls).toBe(1));
      fireEvent.click(screen.getByRole("button", { name: action }));
      await act(async () => held.resolve({ apps: [first] }));
      expect(screen.queryByRole("button", { name: "첫 계정 앱 상세 열기" })).not.toBeInTheDocument();
      expect(
        JSON.stringify(
          client
            .getQueryCache()
            .getAll()
            .map((q) => q.state.data),
        ),
      ).not.toContain(first.title);
    },
  );
  it.each(["계정 변경", "읽기 전용 전환", "쓰기 권한 회수"])(
    "저장 중 %s 이후 응답은 알림·재조회·새 초안에 반영하지 않는다",
    async (action) => {
      const held = deferred();
      const api = mockApi({
        "GET /admin/apps": () => ({ apps: [first] }),
        "POST /admin/apps": () => held.promise,
      });
      const user = userEvent.setup();
      setup();
      await user.click(await screen.findByRole("button", { name: "새 업무 앱" }));
      const dialog = await screen.findByRole("dialog", { name: "새 AI 업무 앱" });
      await user.type(within(dialog).getByRole("textbox", { name: /제목/u }), "저장할 초안");
      await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
      await user.click(
        within(dialog).getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다." }),
      );
      await user.click(within(dialog).getByRole("button", { name: "앱 만들기" }));
      await waitFor(() => expect(api.bodies("POST /admin/apps")).toHaveLength(1));
      expect(api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST")?.[1]).toEqual(
        expect.objectContaining({ retryUnauthorized: false }),
      );
      fireEvent.click(screen.getByRole("button", { name: action, hidden: true }));
      await act(async () => undefined);
      const reads = api.calls.filter((c) => c.key === "GET /admin/apps").length;
      await act(async () => held.resolve(first));
      expect(api.calls.filter((c) => c.key === "GET /admin/apps")).toHaveLength(reads);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      if (action !== "계정 변경")
        expect(within(dialog).getByRole("textbox", { name: /제목/u })).toHaveValue("저장할 초안");
    },
  );
  it.each(["발행", "지원 중단", "삭제"])(
    "%s 확인 중 읽기 전용 전환은 요청을 보내지 않는다",
    async (action) => {
      const api = mockApi({ "GET /admin/apps": () => ({ apps: [first] }) });
      const user = userEvent.setup();
      setup();
      await user.click(await screen.findByRole("button", { name: "첫 계정 앱 상세 열기" }));
      const sheet = screen.getByRole("dialog", { name: first.title });
      await user.click(within(sheet).getByRole("button", { name: action }));
      const confirm = await screen.findByRole("dialog", { name: `업무 앱 ${action}` });
      fireEvent.click(screen.getByRole("button", { name: "읽기 전용 전환", hidden: true }));
      expect(within(confirm).getByRole("button", { name: action })).toBeDisabled();
      fireEvent.click(within(confirm).getByRole("button", { name: action }));
      expect(api.calls.filter((c) => c.key.startsWith("POST") || c.key.startsWith("DELETE"))).toEqual([]);
    },
  );
  it.each([{}, { checks: [] }, { checks: [{ severity: "required", ok: true }] }])(
    "불완전한 발행 차단 응답은 강제 발행으로 연결하지 않는다: %j",
    async (details) => {
      mockApi({
        "GET /admin/apps": () => ({ apps: [first] }),
        "POST /admin/apps/first/publish": () => {
          throw new AppError("blocked", { status: 422, kind: "http", details });
        },
      });
      const user = userEvent.setup();
      setup();
      await user.click(await screen.findByRole("button", { name: "첫 계정 앱 상세 열기" }));
      await user.click(
        within(screen.getByRole("dialog", { name: first.title })).getByRole("button", { name: "발행" }),
      );
      const confirm = await screen.findByRole("dialog", { name: "업무 앱 발행" });
      await user.type(within(confirm).getByRole("textbox"), "발행 검토 완료");
      await user.click(within(confirm).getByRole("button", { name: "발행" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(
        screen.queryByRole("dialog", { name: "온보딩 미충족 상태로 강제 발행" }),
      ).not.toBeInTheDocument();
    },
  );
});
