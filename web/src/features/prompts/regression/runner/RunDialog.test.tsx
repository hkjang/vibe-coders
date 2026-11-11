import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { usePreferences } from "@/shared/stores/preferences";
import { AppError } from "@/shared/api/error";
import { mockApi } from "@/test/api";
import { goldenPrompts, goldenWorkflows } from "../../../../../tests/fixtures/golden-regression";
import {
  promptRevisions,
  promptRun,
  workflowRevisions,
  workflowRun,
} from "../../../../../tests/fixtures/golden-run";
import { RegressionPage } from "../RegressionPage";

const runtime = vi.hoisted(() => ({
  id: "public-runner",
  scopes: ["admin:read", "admin:write"],
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ role: "admin", scopes: runtime.scopes, user: { id: runtime.id } }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
function setup(workflow = false, capability = true) {
  const state = {
    prompts: structuredClone(goldenPrompts),
    revisions: structuredClone(promptRevisions),
    readError: undefined as AppError | undefined,
    run: async (): Promise<unknown> => structuredClone(workflow ? workflowRun : promptRun),
  };
  const api = mockApi({
    "GET /admin/golden-prompts": () => {
      if (state.readError) throw state.readError;
      return {
        golden_prompts: state.prompts,
        results: [],
        ...(capability ? { run_revisions: state.revisions } : {}),
      };
    },
    "GET /admin/golden-workflows": () => ({
      workflows: goldenWorkflows,
      ...(capability ? { run_revisions: workflowRevisions } : {}),
    }),
    "POST /admin/golden-prompts/run-reviewed": () => state.run(),
    "POST /admin/golden-workflows/run-reviewed": () => state.run(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/prompts/regression${workflow ? "?tab=workflows" : ""}`]}>
        <FeatureAccessContext.Provider
          value={{
            featureId: "prompts.regression",
            permitted: true,
            readOnly: runtime.readOnly,
            status: "preview",
          }}
        >
          <RegressionPage />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, client, state, user: userEvent.setup(), update: () => view.rerender(tree()) };
}
beforeEach(() => {
  Object.assign(runtime, { id: "public-runner", scopes: ["admin:read", "admin:write"], readOnly: false });
  tokenStore.clearAll();
  usePreferences.setState({ refreshInterval: 0 });
});
async function open(c: ReturnType<typeof setup>, workflow = false) {
  await waitFor(() => expect(screen.getByRole("button", { name: "회귀 검사 실행" })).toBeEnabled());
  await c.user.click(screen.getByRole("button", { name: "회귀 검사 실행" }));
  const dialog = screen.getByRole("dialog", { name: "회귀 검사 실행" });
  if (workflow)
    await c.user.selectOptions(
      within(dialog).getByRole("combobox", { name: "실행할 워크플로" }),
      "public-workflow-a",
    );
  else await c.user.click(within(dialog).getByRole("checkbox", { name: "한글 답변 확인" }));
  await c.user.type(
    within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" }),
    workflow ? "public-model-a" : "public-model-a\npublic-model-b",
  );
  return dialog;
}
async function approve(c: ReturnType<typeof setup>, dialog: HTMLElement) {
  await c.user.click(within(dialog).getByRole("button", { name: "실행 내용 검토" }));
  await c.user.click(
    await within(dialog).findByRole("checkbox", {
      name: "실행 범위와 실제 모델 호출 비용 발생을 확인했습니다.",
    }),
  );
}
it.each([false, true])("검토된 %s 실행은 한 번만 전송하고 결과 비교를 표시한다", async (workflow) => {
  const c = setup(workflow),
    dialog = await open(c, workflow);
  expect(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" }));
  const result = await screen.findByRole("dialog", { name: "회귀 검사 실행 결과" });
  expect(within(result).getByText("통과 기준을 충족하지 못했습니다")).toBeVisible();
  expect(within(result).getByRole("table", { name: "모델별 회귀 검사 비교" })).toBeVisible();
  const key = `POST /admin/golden-${workflow ? "workflows" : "prompts"}/run-reviewed`;
  expect(c.api.bodies(key)).toEqual([
    expect.objectContaining({
      models: workflow ? ["public-model-a"] : ["public-model-a", "public-model-b"],
      min_pass_rate: 1,
      review: {
        definitions: workflow
          ? { "public-workflow-a": "b".repeat(64) }
          : { "public-prompt-a": "a".repeat(64) },
        max_calls: 64,
        max_output_tokens: 512,
      },
    }),
  ]);
  expect(
    c.api.spy.mock.calls.find(([endpoint]) => endpoint.path.endsWith("/run-reviewed"))?.[1],
  ).toMatchObject({
    retryUnauthorized: false,
    timeoutMs: 150_000,
  });
  await c.user.click(within(result).getByRole("button", { name: "결과 닫기" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "회귀 검사 실행" })).toHaveFocus());
});
it("검토 후 A→B→A 변경도 확인을 해제한다", async () => {
  const c = setup(),
    dialog = await open(c);
  await approve(c, dialog);
  await c.user.type(within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" }), "X{Backspace}");
  expect(within(dialog).queryByRole("checkbox", { name: /실행 범위와/ })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  expect(c.api.bodies("POST /admin/golden-prompts/run-reviewed")).toHaveLength(0);
});
it.each(["readonly", "scope"])("%s 전환은 실행을 막되 입력을 보존한다", async (mode) => {
  const c = setup(),
    dialog = await open(c);
  await approve(c, dialog);
  if (mode === "readonly") runtime.readOnly = true;
  else runtime.scopes = ["admin:read"];
  c.update();
  expect(within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" })).toHaveValue(
    "public-model-a\npublic-model-b",
  );
  expect(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
});
it("최신 정의를 다시 조회하고 변경된 검토를 해제한다", async () => {
  const c = setup(),
    dialog = await open(c);
  await approve(c, dialog);
  c.state.revisions["public-prompt-a"] = "c".repeat(64);
  await act(() => c.client.invalidateQueries());
  expect(
    await within(dialog).findByText("정의가 갱신되었습니다. 실행 내용을 다시 검토하세요."),
  ).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  expect(within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" })).toHaveValue(
    "public-model-a\npublic-model-b",
  );
});
it("최신 조회 권한 오류는 실행 창과 이전 데이터를 제거한다", async () => {
  const c = setup(),
    dialog = await open(c);
  c.state.readError = new AppError("denied", { kind: "permission", status: 403 });
  await c.user.click(within(dialog).getByRole("button", { name: "실행 내용 검토" }));
  expect(await screen.findByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" })).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(c.api.bodies("POST /admin/golden-prompts/run-reviewed")).toHaveLength(0);
});
it("알 수 없는 실행 결과는 재전송 없이 잠그고 안전한 요청 ID를 표시한다", async () => {
  const c = setup(),
    dialog = await open(c);
  c.state.run = async () => {
    throw new AppError("corp_privatecredential", { kind: "network", requestId: "public-request" });
  };
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" }));
  expect(await within(dialog).findByText("실행 결과 확인 필요")).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" })).toBeDisabled();
  expect(within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" })).toBeDisabled();
  expect(dialog).not.toHaveTextContent("corp_privatecredential");
  expect(dialog).toHaveTextContent("public-request");
  expect(c.api.bodies("POST /admin/golden-prompts/run-reviewed")).toHaveLength(1);
});
it("진행 중 중복 실행과 소유자 변경 후 결과 표시를 차단한다", async () => {
  const c = setup(),
    dialog = await open(c);
  let resolve: (value: unknown) => void = () => undefined;
  c.state.run = () =>
    new Promise((done) => {
      resolve = done;
    });
  await approve(c, dialog);
  await c.user.dblClick(within(dialog).getByRole("button", { name: "검토한 내용으로 실행" }));
  expect(c.api.bodies("POST /admin/golden-prompts/run-reviewed")).toHaveLength(1);
  runtime.id = "another-public-runner";
  c.update();
  await act(async () => {
    resolve(promptRun);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "이번 실행 결과" })).not.toBeInTheDocument();
});
it("구 서버는 검토 기능 없이 실행하지 않고 초안 닫기는 확인한다", async () => {
  const old = setup(false, false);
  await screen.findByRole("link", { name: "한글 답변 확인" });
  expect(screen.getByRole("button", { name: "회귀 검사 실행" })).toBeDisabled();
  old.unmount();
  const c = setup(),
    dialog = await open(c);
  await c.user.click(within(dialog).getByRole("button", { name: "취소" }));
  await c.user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
  );
  expect(within(dialog).getByRole("textbox", { name: "비교할 모델 식별자" })).toHaveValue(
    "public-model-a\npublic-model-b",
  );
});

it("정의 검색으로 숨겨진 선택도 유지하며 다른 행을 추가한다", async () => {
  const c = setup(),
    dialog = await open(c);
  const search = within(dialog).getByRole("textbox", { name: "정의 이름 검색" });
  await c.user.type(search, "빈 기대");
  await c.user.click(within(dialog).getByRole("checkbox", { name: "빈 기대 내용 확인" }));
  await c.user.clear(search);
  expect(within(dialog).getByRole("checkbox", { name: "한글 답변 확인" })).toBeChecked();
  expect(within(dialog).getByRole("checkbox", { name: "빈 기대 내용 확인" })).toBeChecked();
  await approve(c, dialog);
  expect(within(dialog).getByText("4회 / 64회")).toBeVisible();
});
it("민감한 식별자는 실행 선택값에도 노출하지 않는다", async () => {
  const c = setup();
  const first = goldenPrompts[0];
  if (!first) throw new Error("public fixture missing");
  c.state.prompts.push({ ...first, id: "corp_" + "x".repeat(40), name: "민감한 식별자 정의" });
  await act(() => c.client.invalidateQueries());
  const dialog = await open(c);
  expect(within(dialog).queryByRole("checkbox", { name: "민감한 식별자 정의" })).not.toBeInTheDocument();
  expect(dialog.innerHTML).not.toContain("corp_" + "x".repeat(40));
});
