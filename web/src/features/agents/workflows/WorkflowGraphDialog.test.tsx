import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "@/shared/api/generated";
import { WorkflowPage } from "./WorkflowPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { workflowReadFixture } from "@/test/workflow-fixtures";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ backendVersion: "v0.86.160" }) };
});
const definition: WorkflowDefinition = {
  id: "workflow_branch",
  name: "분기 업무",
  description: "",
  allowed_teams: "platform",
  enabled: true,
  created_by: "operator",
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
  steps: [{ id: "start", name: "입력 전달", type: "transform" }],
  flow: { version: 1, entry: "start", edges: [{ from: "start", to: "$end", when: "next" }] },
};
let changeReadonly: (value: boolean) => void;
function Harness() {
  const [readOnly, setReadOnly] = useState(false);
  useLayoutEffect(() => {
    changeReadonly = setReadOnly;
  }, []);
  return (
    <FeatureAccessHarness featureId="agents.workflows" readOnly={readOnly}>
      <WorkflowPage />
    </FeatureAccessHarness>
  );
}
function setup(failure = false) {
  const state = { definition, revision: "a".repeat(64) };
  const api = mockApi({
    "GET /admin/workflows": ({ query }) =>
      (query as { view?: string })?.view === "review"
        ? { workflow: state.definition, revision: state.revision }
        : workflowReadFixture([state.definition], query),
    "POST /admin/workflows/workflow_branch/publish": () => {
      if (failure) throw apiFailure("private publish detail", 409, "req_publish_conflict");
      return { workflow_id: definition.id, version: 1, enabled: true, published: true };
    },
    "POST /admin/workflows": ({ body }) => {
      if (failure) throw apiFailure("private server detail", 409, "req_graph_conflict");
      const input = body as { workflow: WorkflowDefinition };
      return { workflow: { ...definition, ...input.workflow }, revision: "b".repeat(64) };
    },
  });
  const rendered = renderScreen(<Harness />, {
    path: "/agents/workflows",
    route: "/agents/workflows?workflow=workflow_branch",
  });
  return { api, state, user: userEvent.setup(), ...rendered };
}
async function edit(current: ReturnType<typeof setup>) {
  const detail = await screen.findByRole("dialog", { name: "분기 업무" });
  await current.user.click(within(detail).getByRole("button", { name: "수정" }));
  const dialog = await screen.findByRole("dialog", { name: "분기 워크플로 수정" });
  await current.user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "연결 검토");
  return dialog;
}
async function review(current: ReturnType<typeof setup>, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await within(dialog).findByRole("heading", { name: "저장 전 검토" });
}
describe("워크플로 분기 검토 저장", () => {
  beforeEach(() => {
    changeReadonly = () => undefined;
  });
  it("검토 전 저장하지 않고 현재 정의 리비전과 사유를 한 번 전송한다", async () => {
    const current = setup();
    const dialog = await edit(current);
    const save = within(dialog).getByRole("button", { name: "검토한 정의 저장" });
    expect(save).toBeDisabled();
    await review(current, dialog);
    expect(within(dialog).getByRole("heading", { name: "저장 전 검토" })).toHaveFocus();
    await current.user.click(save);
    await waitFor(() => expect(current.api.bodies("POST /admin/workflows")).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "분기 업무" })).getByRole("button", { name: "수정" }),
      ).toHaveFocus(),
    );
    expect(current.api.bodies("POST /admin/workflows")[0]).toMatchObject({
      expected_revision: "a".repeat(64),
      reason: "연결 검토",
      workflow: { id: definition.id, flow: definition.flow },
    });
  });
  it("입력 및 읽기 전용 전환 후에는 이전 검토로 저장할 수 없다", async () => {
    const current = setup();
    const dialog = await edit(current);
    await review(current, dialog);
    await current.user.type(within(dialog).getByLabelText("워크플로 이름", { exact: false }), " 변경");
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeDisabled();
    await review(current, dialog);
    act(() => changeReadonly(true));
    act(() => changeReadonly(false));
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeDisabled();
    expect(current.api.bodies("POST /admin/workflows")).toHaveLength(0);
  });
  it("너무 긴 설명을 전송하지 않고 초안을 유지한 채 수정할 수 있다", async () => {
    const current = setup();
    const dialog = await edit(current);
    const description = within(dialog).getByLabelText("설명", { exact: true });
    fireEvent.change(description, { target: { value: "가".repeat(2667) } });
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(await within(dialog).findByText("설명이 너무 깁니다. 최대 8,000바이트입니다.")).toBeVisible();
    expect(description).toHaveValue("가".repeat(2667));
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeDisabled();
    expect(current.api.bodies("POST /admin/workflows")).toHaveLength(0);
    fireEvent.change(description, { target: { value: "검토할 설명" } });
    await review(current, dialog);
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeEnabled();
  });
  it("충돌 응답 후 요청을 반복하지 않고 최신 정의 조회를 안내한다", async () => {
    const current = setup(true);
    const dialog = await edit(current);
    await review(current, dialog);
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 저장" }));
    expect(await within(dialog).findByText(/req_graph_conflict/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeDisabled();
    expect(dialog).not.toHaveTextContent("private server detail");
    expect(current.api.bodies("POST /admin/workflows")).toHaveLength(1);
  });
  it("재조회로 열린 편집의 기준과 입력을 교체하지 않는다", async () => {
    const current = setup();
    const dialog = await edit(current);
    await current.user.type(within(dialog).getByLabelText("워크플로 이름", { exact: false }), " 내 변경");
    current.state.definition = { ...definition, name: "다른 운영자의 변경" };
    current.state.revision = "c".repeat(64);
    await act(async () => {
      await current.client.invalidateQueries({ queryKey: ["agents", "workflows"] });
    });
    expect(within(dialog).getByLabelText("워크플로 이름", { exact: false })).toHaveValue("분기 업무 내 변경");
    await review(current, dialog);
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 저장" }));
    await waitFor(() => expect(current.api.bodies("POST /admin/workflows")).toHaveLength(1));
    expect(current.api.bodies("POST /admin/workflows")[0]).toMatchObject({
      expected_revision: "a".repeat(64),
    });
  });
  it("연결하지 않은 새 단계를 검토에서 거부하고 그림과 입력의 접근성을 유지한다", async () => {
    const current = setup();
    const dialog = await edit(current);
    expect((await axe.run(dialog)).violations).toEqual([]);
    await current.user.click(within(dialog).getByRole("button", { name: "단계 추가" }));
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(await within(dialog).findByText(/시작 단계에서 도달할 수 없는 단계/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "검토한 정의 저장" })).toBeDisabled();
  });
  it("게시할 전체 정의를 조회한 리비전과 사유로 전송한다", async () => {
    const current = setup();
    const detail = await screen.findByRole("dialog", { name: "분기 업무" });
    await current.user.click(within(detail).getByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "분기 워크플로 게시" });
    expect(within(dialog).getByRole("button", { name: "검토한 정의 게시" })).toBeDisabled();
    expect(within(dialog).getByRole("table", { name: "단계 연결" })).toBeVisible();
    await current.user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "연결과 팀 확인");
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 게시" }));
    await waitFor(() =>
      expect(current.api.bodies("POST /admin/workflows/workflow_branch/publish")).toEqual([
        { expected_revision: "a".repeat(64), note: "연결과 팀 확인" },
      ]),
    );
  });
  it("게시 실패 뒤 중복 전송을 막고 요청 식별자를 남긴다", async () => {
    const current = setup(true);
    const detail = await screen.findByRole("dialog", { name: "분기 업무" });
    await current.user.click(within(detail).getByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "분기 워크플로 게시" });
    await current.user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "검토");
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 게시" }));
    expect(await within(dialog).findByText(/req_publish_conflict/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "검토한 정의 게시" })).toBeDisabled();
    expect(current.api.bodies("POST /admin/workflows/workflow_branch/publish")).toHaveLength(1);
    expect(dialog).not.toHaveTextContent("private publish detail");
  });
  it("게시 사유 입력 오류를 한글로 안내하고 전송 전에 수정하게 한다", async () => {
    const current = setup();
    const detail = await screen.findByRole("dialog", { name: "분기 업무" });
    await current.user.click(within(detail).getByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "분기 워크플로 게시" });
    const reason = within(dialog).getByLabelText("변경 사유", { exact: false });
    fireEvent.change(reason, { target: { value: "가".repeat(501) } });
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 게시" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "게시 사유는 비밀키 없이 500자 이하로 입력하세요.",
    );
    expect(current.api.bodies("POST /admin/workflows/workflow_branch/publish")).toHaveLength(0);
    fireEvent.change(reason, { target: { value: "수정한 게시 사유" } });
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 정의 게시" }));
    await waitFor(() =>
      expect(current.api.bodies("POST /admin/workflows/workflow_branch/publish")).toHaveLength(1),
    );
  });
  it("게시 검토 후 읽기 전용 전환을 되돌려도 다시 검토해야 한다", async () => {
    const current = setup();
    const detail = await screen.findByRole("dialog", { name: "분기 업무" });
    await current.user.click(within(detail).getByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "분기 워크플로 게시" });
    await current.user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "검토");
    act(() => changeReadonly(true));
    act(() => changeReadonly(false));
    expect(within(dialog).getByRole("button", { name: "검토한 정의 게시" })).toBeDisabled();
    expect(current.api.bodies("POST /admin/workflows/workflow_branch/publish")).toHaveLength(0);
  });
});
