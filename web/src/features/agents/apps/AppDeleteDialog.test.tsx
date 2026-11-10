import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppDeleteDialog } from "./AppDeleteDialog";
import { AppScopeBoundary } from "./app-scope";
import { deferred } from "./app-permission-test-support";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "one", scopes: ["admin:read", "admin:write"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.id } }) };
});
const app = {
  id: "review-app",
  title: "삭제 검토 앱",
  description: "업무 설명",
  icon: "app",
  components: [{ kind: "model", ref: "model-one", label: "기본 모델" }],
  allowed_teams: "team-one",
  allowed_roles: "member",
  status: "active",
  owner: "one",
  created_at: "2026-11-10T00:00:00Z",
  updated_at: "2026-11-10T01:00:00Z",
};
const onDelete = vi.fn<(id: string) => Promise<unknown>>();
function Host() {
  const [open, setOpen] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [, render] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <FeatureAccessContext.Provider
      value={{ featureId: "agents.apps", permitted: true, readOnly, status: "preview" }}
    >
      <button ref={trigger} onClick={() => setOpen(true)}>
        삭제창 열기
      </button>
      <button onClick={() => setReadOnly(true)}>읽기 전용</button>
      <button
        onClick={() => {
          runtime.scopes = ["admin:read"];
          render((n) => n + 1);
        }}
      >
        쓰기 회수
      </button>
      <button
        onClick={() => {
          runtime.id = "two";
          setOpen(false);
          render((n) => n + 1);
        }}
      >
        계정 변경
      </button>
      <AppScopeBoundary>
        {open ? (
          <AppDeleteDialog
            id={app.id}
            onClose={() => setOpen(false)}
            onDelete={onDelete}
            returnFocusRef={trigger}
          />
        ) : null}
      </AppScopeBoundary>
    </FeatureAccessContext.Provider>
  );
}
const setup = () =>
  renderScreen(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
const ready = async () => {
  await screen.findByText("삭제 검토 앱");
  return screen.getByRole("dialog", { name: "업무 앱 삭제" });
};
const confirm = async () => {
  const user = userEvent.setup();
  const dialog = await ready();
  await user.type(within(dialog).getByRole("textbox", { name: /확인 문구/u }), app.id);
  await user.click(within(dialog).getByRole("button", { name: "삭제" }));
};
beforeEach(() => {
  runtime.id = "one";
  runtime.scopes = ["admin:read", "admin:write"];
  onDelete.mockReset().mockResolvedValue({ status: "deleted" });
});
describe("업무 앱 삭제 검토", () => {
  it("최신 정의를 표시하고 정확한 ID 입력 후 다시 조회하여 한 번 삭제한다", async () => {
    const api = mockApi({ "GET /admin/apps/review-app": () => app });
    const user = userEvent.setup();
    setup();
    const dialog = await ready();
    const remove = within(dialog).getByRole("button", { name: "삭제" });
    expect(remove).toBeDisabled();
    expect(within(dialog).getByText("1개")).toBeVisible();
    const input = within(dialog).getByRole("textbox", { name: /확인 문구/u });
    await user.type(input, `${app.id} `);
    expect(remove).toBeDisabled();
    await user.clear(input);
    await user.type(input, app.id);
    const before = api.calls.length;
    await user.dblClick(remove);
    await waitFor(() => expect(onDelete).toHaveBeenCalledExactlyOnceWith(app.id));
    expect(api.calls.length).toBe(before + 1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it.each([
    { title: "변경된 앱" },
    { allowed_teams: "other" },
    { components: [{ kind: "model", ref: "other", label: "기본 모델" }] },
    { updated_at: "2026-11-11T00:00:00Z" },
  ])("검토 이후 정의 변경을 감지해 재검토 전까지 삭제를 막는다: %j", async (change) => {
    let current = app;
    mockApi({ "GET /admin/apps/review-app": () => current });
    setup();
    await ready();
    current = { ...app, ...change };
    await confirm();
    expect(await screen.findByText(/앱 정보가 변경되었습니다/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(onDelete).not.toHaveBeenCalled();
  });
  it.each([null, { ...app, id: "other" }, { ...app, components: null }, { id: app.id }])(
    "다른 대상 또는 불완전한 응답은 삭제 대상으로 인정하지 않는다: %j",
    async (response) => {
      mockApi({ "GET /admin/apps/review-app": () => response });
      setup();
      expect(await screen.findByText("삭제 대상을 확인하지 못했습니다.")).toBeVisible();
      expect(screen.queryByRole("textbox", { name: /확인 문구/u })).not.toBeInTheDocument();
      expect(onDelete).not.toHaveBeenCalled();
    },
  );
  it.each([404, 500])("최종 조회의 %s 오류는 삭제하지 않고 요청 ID를 표시한다", async (status) => {
    let fail = false;
    mockApi({
      "GET /admin/apps/review-app": () => {
        if (fail) throw apiFailure("private backend detail", status, "req_preflight");
        return app;
      },
    });
    setup();
    await ready();
    fail = true;
    await confirm();
    expect(await screen.findByText(/req_preflight/u)).toBeVisible();
    expect(screen.queryByText(/private backend detail/u)).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
  it.each(["읽기 전용", "쓰기 회수", "계정 변경"])(
    "최종 조회 대기 중 %s이면 삭제하지 않는다",
    async (action) => {
      const held = deferred();
      let pending = false;
      mockApi({ "GET /admin/apps/review-app": () => (pending ? held.promise : app) });
      setup();
      await ready();
      pending = true;
      await confirm();
      fireEvent.click(screen.getByRole("button", { name: action, hidden: true }));
      await act(async () => held.resolve(app));
      expect(onDelete).not.toHaveBeenCalled();
    },
  );
  it("최종 조회의 403은 검토 내용을 지우고 삭제하지 않는다", async () => {
    let denied = false;
    mockApi({
      "GET /admin/apps/review-app": () => {
        if (denied) throw apiFailure("denied", 403);
        return app;
      },
    });
    setup();
    await ready();
    denied = true;
    await confirm();
    expect(await screen.findByText("업무 앱 조회 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByText(app.title)).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
  it("삭제 응답 실패 후 같은 확인창에서 자동·수동 재전송을 막는다", async () => {
    mockApi({ "GET /admin/apps/review-app": () => app });
    onDelete.mockRejectedValue(apiFailure("private error", 500, "req_delete"));
    setup();
    await confirm();
    expect(await screen.findByText(/req_delete/u)).toBeVisible();
    expect(screen.getByText(/목록과 감사 이력을 확인하세요/u)).toBeVisible();
    const button = screen.getByRole("button", { name: "삭제" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
  it("민감한 제목을 검토에 노출하지 않는다", async () => {
    mockApi({
      "GET /admin/apps/review-app": () => ({ ...app, title: "sk-proj-abcdefghijklmnopqrstuvwx1234567890" }),
    });
    setup();
    expect(await screen.findByText("민감한 제목은 표시하지 않습니다.")).toBeVisible();
    expect(screen.queryByText(/sk-proj-/u)).not.toBeInTheDocument();
  });
});
