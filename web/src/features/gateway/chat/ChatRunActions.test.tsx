import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRunActions } from "./ChatRunActions";
import type * as ActionState from "./run-action-state";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const validation = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, entered: vi.fn() }));
vi.mock("./run-action-state", async (original) => {
  const actual = await original<typeof ActionState>();
  return {
    ...actual,
    runActionSchema: (...args: Parameters<typeof actual.runActionSchema>) =>
      actual.runActionSchema(...args).superRefine(async () => {
        if (validation.hold) {
          validation.entered();
          await validation.hold;
        }
      }),
  };
});
vi.mock("sonner", () => ({ toast: toastSpy }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"], rawPromptView: true }) };
});

const kinds = [
  { kind: "feedback", trigger: "평가 남기기", field: "의견", submit: "저장", draft: "공개 평가 A" },
  {
    kind: "promote",
    trigger: "라우팅 후보로 승격",
    field: "사유",
    submit: "초안으로 저장",
    draft: "공개 사유 A",
  },
  {
    kind: "golden",
    trigger: "골든 답변으로 저장",
    field: "워크플로 이름",
    submit: "저장",
    draft: "공개 회귀 A",
  },
] as const;
const path = (run: string, kind: string) => `POST /admin/chat-test/multi-run/runs/${run}/${kind}`;

beforeEach(() => {
  tokenStore.clearAll();
  vi.clearAllMocks();
  validation.hold = undefined;
});
afterEach(() => vi.restoreAllMocks());

function setup(respond: () => unknown = () => ({ status: "saved" })) {
  // Component callback boundary only: no real Go/auth enforcement, and these
  // handlers deliberately accept every run so escaped writes remain observable.
  const api = mockApi(
    Object.fromEntries(
      ["run-a", "run-c"].flatMap((run) => kinds.map(({ kind }) => [path(run, kind), respond])),
    ),
  );
  let update: (
    value: Partial<{ run: string; readOnly: boolean; allowed: boolean; owner: string; known: boolean }>,
  ) => void = () => undefined;
  function Host() {
    const [state, setState] = useState({
      run: "run-a",
      readOnly: false,
      allowed: true,
      owner: "gateway.chat",
      known: true,
    });
    update = (value) => setState((current) => ({ ...current, ...value }));
    return (
      <FeatureAccessContext.Provider
        value={
          state.known ? { featureId: state.owner, permitted: true, readOnly: state.readOnly } : undefined
        }
      >
        <ChatRunActions
          runId={state.run}
          models={[`${state.run}-model`]}
          prompt={`공개 질문 ${state.run}`}
          canWrite={state.allowed}
          writeDeniedReason="쓰기 권한이 없습니다."
        />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return {
    api,
    view,
    user: userEvent.setup(),
    update: (value: Parameters<typeof update>[0]) => act(() => update(value)),
  };
}

describe("비교 실행 후 작업의 고정 초안", () => {
  for (const scenario of kinds) {
    it(`${scenario.kind}: readonly 전환은 초안을 유지하고 입력과 저장을 잠근다`, async () => {
      const current = setup();
      await current.user.click(screen.getByRole("button", { name: scenario.trigger }));
      const dialog = screen.getByRole("dialog");
      await current.user.type(within(dialog).getByRole("textbox", { name: scenario.field }), scenario.draft);
      current.update({ readOnly: true });
      expect(within(dialog).getByRole("textbox", { name: scenario.field })).toHaveValue(scenario.draft);
      expect(within(dialog).getByRole("textbox", { name: scenario.field })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: scenario.submit })).toBeDisabled();
      expect(current.api.calls).toHaveLength(0);
      current.update({ readOnly: false });
      expect(current.api.calls).toHaveLength(0);
      await current.user.click(within(dialog).getByRole("button", { name: scenario.submit }));
      await waitFor(() => expect(current.api.calls).toHaveLength(1));
    });

    it(`${scenario.kind}: 새 실행 C가 와도 열린 실행 A의 대상과 질문을 저장한다`, async () => {
      const current = setup();
      await current.user.click(screen.getByRole("button", { name: scenario.trigger }));
      const dialog = screen.getByRole("dialog");
      await current.user.type(within(dialog).getByRole("textbox", { name: scenario.field }), scenario.draft);
      current.update({ run: "run-c" });
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining("실행 ID: run-a"));
      expect(within(dialog).getByRole("combobox", { name: "모델" })).toHaveValue("run-a-model");
      await current.user.click(within(dialog).getByRole("button", { name: scenario.submit }));
      await waitFor(() => expect(current.api.calls).toHaveLength(1));
      expect(current.api.calls[0]?.key).toBe(path("run-a", scenario.kind));
      expect(current.api.calls[0]?.options.body).toMatchObject(
        scenario.kind === "golden"
          ? { selected_model: "run-a-model", prompt: "공개 질문 run-a" }
          : { model: "run-a-model" },
      );
    });

    it(`${scenario.kind}: 세션 변경은 민감 초안을 폐기한다`, async () => {
      const current = setup();
      await current.user.click(screen.getByRole("button", { name: scenario.trigger }));
      await current.user.type(
        within(screen.getByRole("dialog")).getByRole("textbox", { name: scenario.field }),
        scenario.draft,
      );
      act(() => tokenStore.clearAll());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(current.api.calls).toHaveLength(0);
      await current.user.click(screen.getByRole("button", { name: scenario.trigger }));
      expect(within(screen.getByRole("dialog")).getByRole("textbox", { name: scenario.field })).toHaveValue(
        "",
      );
    });
  }
});

describe("실행 작업 폼의 저장 및 수명", () => {
  for (const scenario of kinds) {
    it(`${scenario.kind}: 폐기 확인에서 계속 편집하면 A 초안을 유지하고 폐기하면 원래 버튼으로 돌아간다`, async () => {
      const current = setup();
      const trigger = screen.getByRole("button", { name: scenario.trigger });
      await current.user.click(trigger);
      const dialog = screen.getByRole("dialog");
      await current.user.type(within(dialog).getByRole("textbox", { name: scenario.field }), scenario.draft);
      current.update({ run: "run-c" });
      await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
      await current.user.click(screen.getByRole("button", { name: "계속 편집" }));
      expect(within(dialog).getByRole("textbox", { name: scenario.field })).toHaveValue(scenario.draft);
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining("실행 ID: run-a"));
      await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
      await current.user.click(screen.getByRole("button", { name: "변경 버리기" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(current.api.calls).toHaveLength(0);
    });

    it(`${scenario.kind}: 실패 Request ID와 초안 유지, 수동 재시도는 같은 실행에만 저장`, async () => {
      let attempt = 0;
      const current = setup(() => {
        if (attempt++ === 0) throw apiFailure("합성 저장 실패", 503, "public-request-a");
        return { status: "saved" };
      });
      await current.user.click(screen.getByRole("button", { name: scenario.trigger }));
      const dialog = screen.getByRole("dialog");
      await current.user.type(within(dialog).getByRole("textbox", { name: scenario.field }), scenario.draft);
      await current.user.click(within(dialog).getByRole("button", { name: scenario.submit }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("public-request-a");
      current.update({ run: "run-c", allowed: false });
      expect(within(dialog).getByRole("textbox", { name: scenario.field })).toHaveValue(scenario.draft);
      expect(within(dialog).getByRole("textbox", { name: scenario.field })).toBeDisabled();
      expect(current.api.calls).toHaveLength(1);
      current.update({ allowed: true });
      expect(current.api.calls).toHaveLength(1);
      await current.user.click(within(dialog).getByRole("button", { name: scenario.submit }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(current.api.calls).toHaveLength(2);
      expect(current.api.calls[1]).toEqual(current.api.calls[0]);
      expect(toastSpy.success).toHaveBeenCalledTimes(1);
      expect(toastSpy.error).not.toHaveBeenCalled();
    });
  }

  for (const change of ["readonly", "scope", "owner", "epoch"] as const) {
    it(`비동기 검증 도중 ${change} 전환은 실제 submit 뒤에도 API 0`, async () => {
      const current = setup();
      await current.user.click(screen.getByRole("button", { name: "평가 남기기" }));
      const dialog = screen.getByRole("dialog");
      await current.user.type(within(dialog).getByRole("textbox", { name: "의견" }), "공개 검증 초안");
      let release!: () => void;
      validation.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const form = dialog.querySelector("form");
      if (!form) throw new Error("missing action form");
      fireEvent.submit(form);
      await waitFor(() => expect(validation.entered).toHaveBeenCalled());
      if (change === "readonly") current.update({ readOnly: true });
      if (change === "scope") current.update({ allowed: false });
      if (change === "owner") current.update({ owner: "gateway.models" });
      if (change === "epoch") act(() => tokenStore.clearAll());
      await act(async () => {
        release();
        await validation.hold;
      });
      expect(current.api.calls).toHaveLength(0);
      expect(toastSpy.success).not.toHaveBeenCalled();
      if (change === "readonly" || change === "scope") {
        expect(within(dialog).getByRole("textbox", { name: "의견" })).toHaveValue("공개 검증 초안");
        current.update({ readOnly: false, allowed: true });
        expect(current.api.calls).toHaveLength(0);
        await current.user.click(within(dialog).getByRole("button", { name: "저장" }));
        await waitFor(() => expect(current.api.calls).toHaveLength(1));
      } else expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  }

  it("pending은 입력·닫기·중복 submit을 잠그고 admitted readonly 성공은 완료한다", async () => {
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const current = setup(() => response);
    await current.user.click(screen.getByRole("button", { name: "평가 남기기" }));
    const dialog = screen.getByRole("dialog");
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing action form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(current.api.calls).toHaveLength(1));
    expect(within(dialog).getByRole("textbox", { name: "의견" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await current.user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    current.update({ readOnly: true });
    await act(async () => {
      release({ status: "saved" });
      await response;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(current.api.calls).toHaveLength(1);
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`이전 세션 ${outcome}가 새 세션 폼과 새 pending을 닫거나 해제하지 않는다`, async () => {
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (cause: unknown) => void;
      const oldResponse = new Promise((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      let resolveNew!: (value: unknown) => void;
      const newResponse = new Promise((resolve) => {
        resolveNew = resolve;
      });
      let count = 0;
      const current = setup(() => (count++ === 0 ? oldResponse : newResponse));
      await current.user.click(screen.getByRole("button", { name: "평가 남기기" }));
      await current.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "저장" }));
      await waitFor(() => expect(current.api.calls).toHaveLength(1));
      act(() => tokenStore.clearAll());
      await current.user.click(screen.getByRole("button", { name: "평가 남기기" }));
      const newDialog = screen.getByRole("dialog");
      await current.user.type(within(newDialog).getByRole("textbox", { name: "의견" }), "새 세션 초안");
      await current.user.click(within(newDialog).getByRole("button", { name: "저장" }));
      await waitFor(() => expect(current.api.calls).toHaveLength(2));
      await act(async () => {
        if (outcome === "success") resolveOld({ status: "saved" });
        else rejectOld(apiFailure("이전 실패", 503, "public-old-request"));
        await oldResponse.catch(() => undefined);
      });
      expect(newDialog).toBeInTheDocument();
      expect(within(newDialog).getByRole("textbox", { name: "의견" })).toHaveValue("새 세션 초안");
      expect(within(newDialog).getByRole("button", { name: "저장 중" })).toBeDisabled();
      expect(within(newDialog).queryByRole("alert")).not.toBeInTheDocument();
      expect(toastSpy.success).not.toHaveBeenCalled();
      expect(toastSpy.error).not.toHaveBeenCalled();
      await act(async () => {
        resolveNew({ status: "saved" });
        await newResponse;
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(toastSpy.success).toHaveBeenCalledTimes(1);
      expect(current.api.calls).toHaveLength(2);
    });
  }
});
