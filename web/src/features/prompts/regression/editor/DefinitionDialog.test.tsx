import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { usePreferences } from "@/shared/stores/preferences";
import { AppError } from "@/shared/api/error";
import type { GoldenPrompt, GoldenWorkflow } from "@/shared/api/domains/golden";
import { mockApi } from "@/test/api";
import { goldenPrompts, goldenWorkflows } from "../../../../../tests/fixtures/golden-regression";
import { RegressionPage } from "../RegressionPage";

const firstPrompt = goldenPrompts[0];
if (!firstPrompt) throw new Error("public prompt fixture missing");
const runtime = vi.hoisted(() => ({
  id: "public-editor",
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
function setup(route = "/prompts/regression") {
  let prompts = structuredClone(goldenPrompts),
    workflows = structuredClone(goldenWorkflows);
  let readError: AppError | undefined;
  let savePrompt = async (body: GoldenPrompt) => {
    const saved = { ...body, created_at: "2031-01-01T00:00:00Z", updated_at: "2031-01-02T00:00:00Z" };
    prompts = [...prompts.filter((row) => row.id !== saved.id), saved];
    return { golden_prompt: saved, results: [] };
  };
  const api = mockApi({
    "GET /admin/golden-prompts": () => {
      if (readError) throw readError;
      return { golden_prompts: prompts, results: [] };
    },
    "GET /admin/golden-workflows": () => ({ workflows }),
    "POST /admin/golden-prompts": ({ body }) => savePrompt(body as GoldenPrompt),
    "POST /admin/golden-workflows": ({ body }) => {
      const saved = {
        ...(body as GoldenWorkflow),
        created_at: "2031-01-01T00:00:00Z",
        updated_at: "2031-01-02T00:00:00Z",
      };
      workflows = [...workflows.filter((row) => row.id !== saved.id), saved];
      return saved;
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
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
  return {
    ...view,
    api,
    client,
    user: userEvent.setup(),
    update: () => view.rerender(tree()),
    setPrompts: (next: GoldenPrompt[]) => {
      prompts = next;
    },
    setReadError: (error: AppError) => {
      readError = error;
    },
    setSave: (next: typeof savePrompt) => {
      savePrompt = next;
    },
  };
}
beforeEach(() => {
  Object.assign(runtime, { id: "public-editor", scopes: ["admin:read", "admin:write"], readOnly: false });
  tokenStore.clearAll();
  usePreferences.setState({ refreshInterval: 0 });
});
async function create(c: ReturnType<typeof setup>) {
  await c.user.click(await screen.findByRole("button", { name: "기준 프롬프트 추가" }));
  const dialog = screen.getByRole("dialog", { name: "기준 프롬프트 추가" });
  await c.user.type(within(dialog).getByRole("textbox", { name: "이름" }), "공개 기준");
  await c.user.type(within(dialog).getByRole("textbox", { name: "기준 프롬프트" }), "공개 질문");
  return dialog;
}
async function approve(c: ReturnType<typeof setup>, dialog: HTMLElement) {
  await c.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await c.user.click(within(dialog).getByRole("checkbox"));
}
it("정의 등록은 검토·확인 후 한 번만 전송하고 목록을 갱신한다", async () => {
  const c = setup(),
    dialog = await create(c);
  expect(within(dialog).getByRole("button", { name: "정의 등록" })).toBeDisabled();
  await approve(c, dialog);
  expect(within(dialog).getByRole("heading", { name: "저장 전 변경 비교" })).toBeVisible();
  await c.user.click(within(dialog).getByRole("button", { name: "정의 등록" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(await screen.findByRole("link", { name: "공개 기준" })).toBeVisible();
  expect(c.api.bodies("POST /admin/golden-prompts")).toEqual([
    expect.objectContaining({ name: "공개 기준", prompt: "공개 질문" }),
  ]);
  expect(Object.keys(c.api.bodies("POST /admin/golden-prompts")[0] as object).sort()).toEqual([
    "expected",
    "id",
    "name",
    "prompt",
    "tags",
  ]);
});
it("검토 후 A→B→A 변경도 확인을 해제하고 첫 오류 필드로 이동한다", async () => {
  const c = setup(),
    dialog = await create(c);
  await approve(c, dialog);
  const name = within(dialog).getByRole("textbox", { name: "이름" });
  await c.user.type(name, "X{Backspace}");
  expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "정의 등록" })).toBeDisabled();
  await c.user.clear(name);
  await c.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await waitFor(() => expect(name).toHaveFocus());
  expect(within(dialog).getByText("이름을 입력하세요.")).toBeVisible();
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(0);
});
it("저장하지 않은 초안은 닫기 확인에서 계속 편집할 수 있다", async () => {
  const c = setup(),
    dialog = await create(c);
  await c.user.click(within(dialog).getByRole("button", { name: "취소" }));
  const confirmation = await screen.findByRole("alertdialog");
  await c.user.click(within(confirmation).getByRole("button", { name: "계속 편집" }));
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toHaveValue("공개 기준");
});
it.each(["readonly", "scope"])("%s 변경은 초안을 유지하면서 저장을 차단한다", async (kind) => {
  const c = setup(),
    dialog = await create(c);
  await approve(c, dialog);
  if (kind === "readonly") runtime.readOnly = true;
  else runtime.scopes = ["admin:read"];
  c.update();
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toHaveValue("공개 기준");
  expect(within(dialog).getByRole("button", { name: "정의 등록" })).toBeDisabled();
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(0);
});
it("최신 정의가 달라지면 초안을 보존하고 덮어쓰지 않는다", async () => {
  const c = setup("/prompts/regression?selection=public-prompt-a");
  await c.user.click(await screen.findByRole("button", { name: "정의 편집" }));
  const dialog = screen.getByRole("dialog", { name: "기준 프롬프트 편집" });
  await c.user.type(within(dialog).getByRole("textbox", { name: "이름" }), " 변경");
  await approve(c, dialog);
  c.setPrompts([{ ...firstPrompt, prompt: "다른 관리자의 수정" }]);
  await c.user.click(within(dialog).getByRole("button", { name: "수정 저장" }));
  expect(await within(dialog).findByText(/다른 변경이 있거나/)).toBeVisible();
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(0);
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toHaveValue("한글 답변 확인 변경");
});
it("워크플로 편집은 단계 이동과 빈 기대 내용을 보존한다", async () => {
  const c = setup("/prompts/regression?tab=workflows&selection=public-workflow-a");
  await c.user.click(await screen.findByRole("button", { name: "정의 편집" }));
  const dialog = screen.getByRole("dialog", { name: "검증 워크플로 편집" });
  await c.user.click(within(dialog).getByRole("button", { name: "2단계 위로 이동" }));
  expect(within(dialog).getByRole("textbox", { name: "1단계 검사 프롬프트" })).toHaveValue("두 번째 질문");
  await c.user.clear(within(dialog).getByRole("textbox", { name: "1단계 기대 내용" }));
  await c.user.click(within(dialog).getByRole("button", { name: "검증 단계 추가" }));
  expect(within(dialog).getByRole("textbox", { name: "3단계 이름" })).toHaveFocus();
  await c.user.type(within(dialog).getByRole("textbox", { name: "3단계 검사 프롬프트" }), "임시 검사");
  await c.user.click(within(dialog).getByRole("button", { name: "3단계 삭제" }));
  expect(within(dialog).getByRole("textbox", { name: "2단계 이름" })).toHaveFocus();
  expect(within(dialog).getByRole("textbox", { name: "1단계 기대 내용" })).toHaveValue("");
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "수정 저장" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(c.api.bodies("POST /admin/golden-workflows")).toEqual([
    expect.objectContaining({
      steps: [
        expect.objectContaining({ prompt: "두 번째 질문", expected: "" }),
        expect.objectContaining({ prompt: "첫 질문", source_run_id: "public-source", baseline_score: 82.5 }),
      ],
    }),
  ]);
});
it("저장 중 중복 전송을 막고 응답 유실 후 GET 비교로만 완료한다", async () => {
  const c = setup(),
    dialog = await create(c);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.setSave(async (body) => {
    await gate;
    c.setPrompts([{ ...body, created_at: "2031-01-01T00:00:00Z", updated_at: "2031-01-01T00:00:00Z" }]);
    throw new AppError("lost response", { kind: "network" });
  });
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "정의 등록" }));
  await waitFor(() => expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(1));
  expect(within(dialog).getByRole("button", { name: "저장 중" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
  await act(async () => {
    release();
    await gate;
  });
  const check = await within(dialog).findByRole("button", { name: "저장 결과 확인" });
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toBeDisabled();
  await c.user.click(check);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(1);
});
it("계정 전환 후 늦은 성공은 새 계정에 알림이나 데이터로 반영하지 않는다", async () => {
  const c = setup(),
    dialog = await create(c),
    success = vi.spyOn(toast, "success");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.setSave(async (body) => {
    await gate;
    return { golden_prompt: { ...body, created_at: "0", updated_at: "0" }, results: [] };
  });
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "정의 등록" }));
  await waitFor(() => expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(1));
  runtime.id = "public-second";
  c.update();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => {
    release();
    await gate;
  });
  expect(success).not.toHaveBeenCalled();
  expect(
    JSON.stringify(
      c.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain("공개 질문");
});

it("전송 중 쓰기 권한 회수·복원은 이전 성공을 되살리지 않고 조회 확인으로 전환한다", async () => {
  const c = setup(),
    dialog = await create(c),
    success = vi.spyOn(toast, "success");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.setSave(async (body) => {
    await gate;
    const saved = { ...body, created_at: "2031-01-01T00:00:00Z", updated_at: "2031-01-01T00:00:00Z" };
    c.setPrompts([saved]);
    return { golden_prompt: saved, results: [] };
  });
  await approve(c, dialog);
  await c.user.click(within(dialog).getByRole("button", { name: "정의 등록" }));
  await waitFor(() => expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(1));
  runtime.scopes = ["admin:read"];
  c.update();
  runtime.scopes = ["admin:read", "admin:write"];
  c.update();
  await act(async () => {
    release();
    await gate;
  });
  expect(success).not.toHaveBeenCalled();
  await c.user.click(await within(dialog).findByRole("button", { name: "저장 결과 확인" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(1);
});

it.each([401, 403])("저장 직전 조회 %s 거부는 초안·이전 목록을 제거하고 쓰기를 막는다", async (status) => {
  const c = setup(),
    dialog = await create(c);
  await approve(c, dialog);
  c.setReadError(
    new AppError("private server response", { kind: "permission", status, details: "private body" }),
  );
  await c.user.click(within(dialog).getByRole("button", { name: "정의 등록" }));
  await screen.findByRole("heading", { name: "회귀 검증 조회 권한 확인 필요" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "한글 답변 확인" })).not.toBeInTheDocument();
  expect(c.api.bodies("POST /admin/golden-prompts")).toHaveLength(0);
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
});
