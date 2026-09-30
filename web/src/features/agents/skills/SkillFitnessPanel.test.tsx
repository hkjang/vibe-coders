import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SkillDetailSheet } from "./SkillDetailSheet";
import { fitnessKey } from "./skill-fitness-state";
import type { Skill } from "@/shared/api/domains/agents.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const auth = vi.hoisted(() => ({ write: true }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: auth.write ? ["admin:read", "admin:write"] : ["admin:read"] }) };
});
const get = "GET /admin/skills/fitness",
  post = "POST /admin/skills/fitness";
const skill = { name: "검토/skill", description: "기존 스킬 설명" };
const data = { skill: skill.name, evidence: [], passing_count: 0, required: 2 };
const row = {
  id: "ev-1",
  skill_name: skill.name,
  kind: "multimodel",
  ref_id: "참조",
  passed: true,
  score: 0,
  note: "목록에서 새로 노출하면 안 되는 기존 메모",
  created_by: "writer",
  created_at: "2026-01-01T00:00:00Z",
};
const saved = { ...row, created_at: "" };
function setup(read: ApiHandler = () => data, write: ApiHandler = () => saved, initial = skill) {
  const api = mockApi({ [get]: read, [post]: write });
  const callbacks = { close: vi.fn(), edit: vi.fn(), remove: vi.fn(), promote: vi.fn() };
  let refresh: () => void = () => undefined;
  let select: (value: Skill) => void = () => undefined;
  function Screen() {
    const [selected, setSelected] = useState<Skill>(initial);
    const [open, setOpen] = useState(true);
    const [, redraw] = useState(0);
    const trigger = useRef<HTMLElement | null>(null);
    refresh = () => redraw((value) => value + 1);
    select = setSelected;
    return (
      <>
        <main id="main-content" tabIndex={-1} />
        <SkillDetailSheet
          open={open}
          skill={selected}
          canWrite={auth.write}
          onOpenChange={(next) => {
            callbacks.close(next);
            setOpen(next);
          }}
          onEdit={callbacks.edit}
          onDelete={callbacks.remove}
          onPromote={callbacks.promote}
          returnFocusRef={trigger}
          writeDisabledReason="읽기 전용"
        />
      </>
    );
  }
  return {
    ...renderScreen(<Screen />),
    api,
    callbacks,
    user: userEvent.setup(),
    refresh: () => act(refresh),
    select: (value: Skill) => act(() => select(value)),
  };
}
async function panel(user: ReturnType<typeof userEvent.setup>) {
  const parent = screen.getByRole("dialog", { name: skill.name });
  const fold = within(parent).getByRole("button", { name: "적합성 근거" });
  const close = within(parent).getByRole("button", { name: "패널 닫기" });
  await user.click(fold);
  const trigger = await within(parent).findByRole("button", { name: "근거 기록" });
  return { parent, fold, close, trigger };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  const result = await panel(user);
  await waitFor(() => expect(result.trigger).toBeEnabled());
  await user.click(result.trigger);
  return { ...result, dialog: await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" }) };
}
function submit(dialog: HTMLElement) {
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing fitness form");
  fireEvent.submit(form);
}
beforeEach(() => {
  auth.write = true;
  tokenStore.clearAll();
  toast.success.mockClear();
});

describe("스킬 적합성 근거 공통 폼", () => {
  it.each(["", "-1.25", "0.000000000125"])(
    "빈 점수의 명시적 0과 유한 소수를 기존 POST로 기록한다: %j",
    async (score) => {
      const { user, api } = setup();
      const { dialog } = await open(user);
      expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("");
      expect(within(dialog).getByLabelText("메모")).toHaveValue("");
      await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "\ufeff참조/한글\u0085내부");
      await user.selectOptions(within(dialog).getByRole("combobox", { name: "근거 종류" }), "golden");
      if (score) await user.type(within(dialog).getByLabelText("점수"), score);
      await user.click(within(dialog).getByRole("checkbox", { name: /^통과/u }));
      await user.click(within(dialog).getByRole("button", { name: "근거 기록 저장" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(api.bodies(post)).toEqual([
        {
          skill: skill.name,
          kind: "golden",
          ref_id: "\ufeff참조/한글\u0085내부",
          passed: false,
          score: score ? Number(score) : 0,
          note: "",
        },
      ]);
      expect(toast.success).toHaveBeenCalledTimes(1);
    },
  );
  it("빈 참조/NEL과 비유한 점수는 첫 submit에서 오류를 보이고 전송하지 않는다", async () => {
    const { user, api } = setup();
    const { dialog } = await open(user);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "참조 ID" }), {
      target: { value: " \u0085 " },
    });
    await user.type(within(dialog).getByLabelText("점수"), "Infinity");
    submit(dialog);
    expect(await within(dialog).findByText("근거가 되는 실행·세트 ID를 입력하세요.")).toBeVisible();
    expect(within(dialog).getByText("유한한 숫자를 입력하세요.")).toBeVisible();
    expect(api.bodies(post)).toEqual([]);
  });
  it.each([false, true])(
    "취소·dirty 유지·폐기는 정확한 원래 버튼으로 포커스를 되돌린다: %s",
    async (dirty) => {
      const { user, api } = setup();
      const { dialog, trigger } = await open(user);
      if (dirty) await user.type(within(dialog).getByLabelText("메모"), "남길 초안");
      await user.click(within(dialog).getByRole("button", { name: "취소" }));
      if (dirty) {
        await user.click(await screen.findByRole("button", { name: "계속 편집" }));
        expect(within(dialog).getByLabelText("메모")).toHaveValue("남길 초안");
        await user.keyboard("{Escape}");
        await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
      }
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(api.bodies(post)).toEqual([]);
    },
  );
  it.each(["fold", "close"])("상위 %s 요청도 dirty 확인 뒤에만 실행한다", async (action) => {
    const { user, callbacks, api } = setup();
    const result = await open(user);
    await user.type(within(result.dialog).getByRole("textbox", { name: "참조 ID" }), "초안");
    // Invoke the parent handler boundary; an inert parent cannot be pointer-clicked by a user.
    fireEvent.click(action === "fold" ? result.fold : result.close);
    await user.click(await screen.findByRole("button", { name: "계속 편집" }));
    expect(result.dialog).toBeInTheDocument();
    expect(callbacks.close).not.toHaveBeenCalled();
    fireEvent.click(action === "fold" ? result.fold : result.close);
    await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(result.dialog).not.toBeInTheDocument());
    if (action === "fold") {
      expect(result.fold).toHaveAttribute("aria-expanded", "false");
      await waitFor(() => expect(result.fold).toHaveFocus());
    } else expect(callbacks.close).toHaveBeenCalledWith(false);
    expect(api.bodies(post)).toEqual([]);
  });
  it("조회 갱신과 외부 스킬 선택이 열 때의 대상·기준·초안을 재지정하지 않는다", async () => {
    const { user, api, client, select } = setup();
    const { dialog } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "고정 참조");
    act(() =>
      client.setQueryData(fitnessKey(skill.name, tokenStore.getSessionEpoch()), { ...data, required: 3 }),
    );
    select({ name: "other", description: "바뀐 스킬" });
    expect(within(dialog).getByText("대상 스킬: 검토/skill")).toBeVisible();
    expect(within(dialog).getByText(/열 때 확인한 통과 근거 0건 · 승격 기준 2건/u)).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("고정 참조");
    submit(dialog);
    await waitFor(() => expect(api.bodies(post)).toHaveLength(1));
    expect(api.bodies(post)[0]).toMatchObject({ skill: skill.name, ref_id: "고정 참조" });
  });
  it("실패 요청 ID와 초안을 유지하고 수동 재시도만 별도 불변 body로 보낸다", async () => {
    let attempts = 0;
    const { user, api } = setup(undefined, () => {
      if (++attempts === 1) throw apiFailure("synthetic failure", 503, "req_fitness_retry");
      return saved;
    });
    const { dialog } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "첫 참조");
    submit(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("요청 ID: req_fitness_retry");
    expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("첫 참조");
    expect(api.bodies(post)).toHaveLength(1);
    await user.type(within(dialog).getByLabelText("메모"), "수정 후 수동 재시도");
    submit(dialog);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.bodies(post)).toHaveLength(2);
    expect(api.bodies(post)[0]).toMatchObject({ note: "" });
    expect(api.bodies(post)[1]).toMatchObject({ note: "수정 후 수동 재시도" });
  });
  it("pending 중 필드·중복 저장·부모 close/fold·Escape를 잠근다", async () => {
    let release!: (value: unknown) => void;
    const { user, api, callbacks } = setup(
      undefined,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { dialog, fold, close } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "pending");
    submit(dialog);
    submit(dialog);
    await waitFor(() => expect(api.bodies(post)).toHaveLength(1));
    expect(within(dialog).getByRole("group", { name: "입력 항목" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    expect(fold).toBeDisabled();
    fireEvent.click(close);
    fireEvent.click(fold);
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(callbacks.close).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => release(saved));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
  it("기록 성공 뒤 조회 실패는 성공을 구분하고 목록 재조회는 POST를 반복하지 않는다", async () => {
    let failRead = false;
    const { user, api } = setup(
      () => {
        if (failRead) throw apiFailure("read unavailable", 503, "req_after_record");
        return data;
      },
      () => {
        failRead = true;
        return saved;
      },
    );
    const { dialog } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "성공한 참조");
    submit(dialog);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText("적합성 근거 기록은 완료됐습니다.")).toBeVisible();
    expect(await screen.findByText(/요청 ID: req_after_record/u)).toBeVisible();
    failRead = false;
    await user.click(screen.getByRole("button", { name: "적합성 근거 새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "근거 기록" })).toBeEnabled());
    failRead = true;
    await user.click(screen.getByRole("button", { name: "적합성 근거 새로고침" }));
    await screen.findByText(/요청 ID: req_after_record/u);
    expect(screen.queryByText("적합성 근거 기록은 완료됐습니다.")).not.toBeInTheDocument();
    expect(api.bodies(post)).toHaveLength(1);
  });
  it("정상 저장 후 비활성 trigger 대신 살아 있는 Sheet 안으로 복귀하고 Tab을 유지한다", async () => {
    let recorded = false,
      release!: (value: unknown) => void;
    const { user } = setup(
      () =>
        recorded
          ? new Promise((resolve) => {
              release = resolve;
            })
          : data,
      () => {
        recorded = true;
        return saved;
      },
    );
    const { dialog, parent, trigger } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "새 기록");
    submit(dialog);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toBeDisabled();
    await waitFor(() => expect(parent).toHaveFocus());
    await user.tab();
    expect(parent.contains(document.activeElement)).toBe(true);
    expect(document.getElementById("main-content")).not.toHaveFocus();
    await act(async () => release(data));
    await waitFor(() => expect(trigger).toBeEnabled());
  });
  it("최신 쓰기 권한이 없어지면 열린 초안은 남기고 직접 submit도 전송하지 않는다", async () => {
    const { user, api, refresh } = setup();
    const { dialog } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "권한 변경 전");
    auth.write = false;
    refresh();
    expect(within(dialog).getByRole("button", { name: "근거 기록 저장" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("권한 변경 전");
    submit(dialog);
    expect(api.bodies(post)).toEqual([]);
  });
  it("기존 열만 한글로 보여 주고 raw 메모를 새로 노출하지 않으며 폼 접근성을 유지한다", async () => {
    const { user } = setup(() => ({
      ...data,
      evidence: [{ ...row, score: 0.000000000125 }],
      passing_count: 1,
    }));
    const { parent, trigger } = await panel(user);
    expect(await within(parent).findByText("여러 모델 비교")).toBeVisible();
    expect(within(parent).getByText("1.25e-10")).toBeVisible();
    expect(within(parent).queryByText(row.note)).not.toBeInTheDocument();
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" });
    expect(within(dialog).getByLabelText("메모")).toHaveValue("");
    expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual(
      [],
    );
  });
  it.each([
    null,
    {},
    { ...data, skill: "other" },
    { ...data, evidence: null },
    { ...data, passing_count: 1 },
  ])("불완전 조회 %j를 빈 목록이나 기록 전제조건으로 쓰지 않는다", async (response) => {
    const { user, api } = setup(() => response);
    const { trigger, parent } = await panel(user);
    await waitFor(() =>
      expect(within(parent).getByRole("button", { name: "적합성 근거 새로고침" })).toBeEnabled(),
    );
    expect(trigger).toBeDisabled();
    expect(within(parent).queryByText("등록된 근거가 없습니다.")).not.toBeInTheDocument();
    expect(
      within(parent).getByText("현재 스킬의 적합성 근거를 확인하기 전에는 기록할 수 없습니다."),
    ).toBeVisible();
    expect(api.bodies(post)).toEqual([]);
  });
  it("조회 오류의 요청 ID를 표시하며 재조회 중 초안·기준은 보존하고 저장을 막는다", async () => {
    let stage = 0,
      release!: (value: unknown) => void;
    const { user, api } = setup(() => {
      if (stage === 0) throw apiFailure("unavailable", 503, "req_prerequisite");
      if (stage === 1) return data;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const { parent, trigger } = await panel(user);
    expect(await within(parent).findByText(/요청 ID: req_prerequisite/u)).toBeVisible();
    expect(trigger).toBeDisabled();
    stage = 1;
    await user.click(within(parent).getByRole("button", { name: "적합성 근거 새로고침" }));
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" });
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "보존할 초안");
    stage = 2;
    await user.click(within(dialog).getByRole("button", { name: "현재 근거 다시 조회" }));
    expect(within(dialog).getByRole("button", { name: "근거 기록 저장" })).toBeDisabled();
    submit(dialog);
    expect(api.bodies(post)).toEqual([]);
    await act(async () => release({ ...data, required: 3 }));
    expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("보존할 초안");
    expect(within(dialog).getByText(/승격 기준 2건/u)).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "근거 기록 저장" })).toBeEnabled());
  });
  it("처음부터 읽기 전용이면 조회는 가능하지만 기록 폼은 열지 않는다", async () => {
    auth.write = false;
    const { user, api } = setup();
    const { trigger } = await panel(user);
    expect(await screen.findByText("등록된 근거가 없습니다.")).toBeVisible();
    expect(trigger).toBeDisabled();
    expect(api.bodies(post)).toEqual([]);
  });
  it("보안 로그아웃은 dirty 확인 없이 초안을 없애고 새 세션에는 빈 입력을 연다", async () => {
    const { user, api } = setup();
    const { dialog, trigger } = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "이전 계정 초안");
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const newer = await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" });
    expect(within(newer).getByRole("textbox", { name: "참조 ID" })).toHaveValue("");
    expect(api.bodies(post)).toEqual([]);
  });
});
