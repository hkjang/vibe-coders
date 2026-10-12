import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPage } from "./WorkflowPage";
import type { WorkflowDryRun } from "@/shared/api/domains/agents.schemas";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { tokenStore } from "@/shared/auth/token-store";
import { toast } from "sonner";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const first = { id: "wf_first", name: "첫 번째 업무", enabled: true, steps: [] };
const second = { id: "wf_second", name: "두 번째 업무", enabled: true, steps: [] };
let changeReadonly: (value: boolean) => void;
let move: (value: string) => void;
function Harness({ readonly = false }: { readonly?: boolean }) {
  const [readOnly, setReadOnly] = useState(readonly);
  const navigate = useNavigate();
  useLayoutEffect(() => {
    changeReadonly = setReadOnly;
    move = navigate;
  }, [navigate]);
  return (
    <FeatureAccessHarness featureId="agents.workflows" readOnly={readOnly}>
      <WorkflowPage />
    </FeatureAccessHarness>
  );
}
function renderPage(readonly = false) {
  return renderScreen(<Harness readonly={readonly} />, {
    path: "/agents/workflows",
    route: "/agents/workflows?workflow=wf_first",
  });
}

describe("워크플로 작업 소유권", () => {
  beforeEach(() => {
    changeReadonly = () => undefined;
    move = () => undefined;
  });

  it("미리보기 읽기 전용에서는 게시·수정·삭제를 막고 모의 검사는 허용한다", async () => {
    mockApi({ "GET /admin/workflows": () => ({ workflows: [first] }) });
    renderPage(true);
    const detail = await screen.findByRole("dialog", { name: first.name });
    for (const name of ["게시", "수정", "삭제"])
      expect(within(detail).getByRole("button", { name })).toBeDisabled();
    expect(within(detail).getByRole("button", { name: "드라이런" })).toBeEnabled();
  });

  it("열린 게시 확인창도 읽기 전용 전환 즉시 제출을 막는다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /admin/workflows": () => ({ workflows: [first] }) });
    renderPage();
    const detail = await screen.findByRole("dialog", { name: first.name });
    await user.click(within(detail).getByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "워크플로 게시" });
    await user.type(within(dialog).getByLabelText(/변경 사유/), "게시 검토");
    act(() => changeReadonly(true));
    expect(within(dialog).getByRole("button", { name: "게시" })).toBeDisabled();
    expect(api.bodies("POST /admin/workflows/wf_first/publish")).toHaveLength(0);
  });

  it("이전 업무의 늦은 모의 검사 결과를 새 상세 화면에 표시하지 않는다", async () => {
    const user = userEvent.setup();
    let finish: (value: WorkflowDryRun) => void = () => undefined;
    const pending = new Promise<WorkflowDryRun>((resolve) => {
      finish = resolve;
    });
    const api = mockApi({
      "GET /admin/workflows": () => ({ workflows: [first, second] }),
      "POST /admin/workflows/wf_first/dry-run": () => pending,
    });
    renderPage();
    const detail = await screen.findByRole("dialog", { name: first.name });
    await user.click(within(detail).getByRole("button", { name: "드라이런" }));
    await waitFor(() => expect(api.bodies("POST /admin/workflows/wf_first/dry-run")).toHaveLength(1));
    act(() => move("/agents/workflows?workflow=wf_second"));
    await screen.findByRole("dialog", { name: second.name });
    await act(async () => {
      finish({ workflow_id: first.id, ok: false, issues: ["이전 업무 검사 결과"] });
      await pending;
    });
    await waitFor(() => expect(screen.queryByText("이전 업무 검사 결과")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "드라이런 결과" })).not.toBeInTheDocument();
  });

  it("편집 중 읽기 전용으로 바뀌면 초안을 보존하고 저장·입력을 잠근다", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /admin/workflows": () => ({ workflows: [first] }) });
    renderPage();
    await user.click(
      within(await screen.findByRole("dialog", { name: first.name })).getByRole("button", { name: "수정" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "워크플로 수정" });
    const name = within(dialog).getByLabelText(/^이름/);
    await user.clear(name);
    await user.type(name, "보존할 초안");
    act(() => changeReadonly(true));
    expect(name).toHaveValue("보존할 초안");
    expect(name).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "수정 저장" })).toBeDisabled();
    act(() => changeReadonly(false));
    expect(name).toHaveValue("보존할 초안");
    expect(within(dialog).getByRole("button", { name: "수정 저장" })).toBeEnabled();
  });

  it("세션이 바뀌면 열린 게시창을 폐기하고 이전 성공 알림을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success").mockImplementation(() => 1);
    let finish: () => void = () => undefined;
    const pending = new Promise<{ published: true; workflow_id: string; version: number }>((resolve) => {
      finish = () => resolve({ published: true, workflow_id: first.id, version: 1 });
    });
    const api = mockApi({
      "GET /admin/workflows": () => ({ workflows: [first] }),
      "POST /admin/workflows/wf_first/publish": () => pending,
    });
    renderPage();
    await user.click(
      within(await screen.findByRole("dialog", { name: first.name })).getByRole("button", { name: "게시" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "워크플로 게시" });
    await user.type(within(dialog).getByLabelText(/변경 사유/), "게시 검토");
    await user.click(within(dialog).getByRole("button", { name: "게시" }));
    await waitFor(() => expect(api.bodies("POST /admin/workflows/wf_first/publish")).toHaveLength(1));
    act(() => tokenStore.clearAll());
    expect(screen.queryByRole("dialog", { name: "워크플로 게시" })).not.toBeInTheDocument();
    await act(async () => {
      finish();
      await pending;
    });
    expect(success).not.toHaveBeenCalled();
  });

  it("응답의 업무 ID가 요청과 다르면 검증 성공으로 표시하지 않는다", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/workflows": () => ({ workflows: [first] }),
      "POST /admin/workflows/wf_first/dry-run": () => ({ workflow_id: second.id, ok: true, steps: [] }),
    });
    renderPage();
    await user.click(
      within(await screen.findByRole("dialog", { name: first.name })).getByRole("button", {
        name: "드라이런",
      }),
    );
    expect(await screen.findByText("드라이런에 실패했습니다.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "드라이런 결과" })).not.toBeInTheDocument();
  });

  it.each(["return", "definition"] as const)(
    "%s 이후에는 이전 정의의 진행 중 검사를 재사용하지 않는다",
    async (change) => {
      const user = userEvent.setup();
      let finish: (value: WorkflowDryRun) => void = () => undefined;
      const pending = new Promise<WorkflowDryRun>((resolve) => {
        finish = resolve;
      });
      mockApi({
        "GET /admin/workflows": () => ({ workflows: [first, second] }),
        "POST /admin/workflows/wf_first/dry-run": () => pending,
      });
      const { client } = renderPage();
      await user.click(
        within(await screen.findByRole("dialog", { name: first.name })).getByRole("button", {
          name: "드라이런",
        }),
      );
      if (change === "return") {
        act(() => move("/agents/workflows?workflow=wf_second"));
        await screen.findByRole("dialog", { name: second.name });
        act(() => move("/agents/workflows?workflow=wf_first"));
      } else {
        act(() =>
          client.setQueryData(["agents", "workflows"], {
            workflows: [{ ...first, description: "다른 정의" }, second],
          }),
        );
      }
      await screen.findByRole("dialog", { name: first.name });
      await act(async () => {
        finish({ workflow_id: first.id, ok: false, issues: ["폐기할 검사 결과"] });
        await pending;
      });
      expect(screen.queryByText("폐기할 검사 결과")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "드라이런 결과" })).not.toBeInTheDocument();
    },
  );
});
