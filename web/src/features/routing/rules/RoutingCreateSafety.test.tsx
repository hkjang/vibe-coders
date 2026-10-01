import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

import {
  createPath,
  createToasts,
  createAndSettle,
  deferred,
  discard,
  expectOnlyCreate,
  firstAction,
  invoke,
  listPath,
  manualSettled,
  openAndFill,
  setupCreate,
  reviewAndAgree,
  storedCreatedAt,
  submittedRule,
  successMessage,
  zeroCreatedAt,
  type CreateHarness,
} from "./routing-create-test-harness";

async function approved(current: CreateHarness) {
  const opened = await openAndFill(current);
  return { ...opened, ...(await reviewAndAgree(current, opened.dialog)) };
}

async function editField(current: CreateHarness, dialog: HTMLElement, label: string, value: string) {
  const field = within(dialog).getByLabelText(new RegExp(label, "u"));
  await current.user.clear(field);
  if (value) await current.user.type(field, value);
  return field;
}

describe("라우팅 생성 실제 경로의 검토·권한·응답 안전성", () => {
  it("정상 양성: 빈 목록에서 입력한 7필드와 enabled true를 POST 한 번 보낸다", async () => {
    const current = await setupCreate();
    const { dialog } = await openAndFill(current);
    await reviewAndAgree(current, dialog);
    await createAndSettle(current, dialog);
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    expect(current.calls.filter((call) => call.key === createPath).map((call) => call.body)).toEqual([
      submittedRule,
    ]);
    expect(current.records.size).toBe(1);
    expect(createToasts().success).toHaveBeenCalledWith(successMessage);
    expect(current.records.get("route_created_1")?.created_at).toBe(storedCreatedAt);
    expect(current.actualListQuery().state.data).toEqual({ rules: [...current.records.values()] });
    expectOnlyCreate(current);
  });

  it("첫 실제 제출은 검토만 하며 확인 전에는 POST 하지 않는다", async () => {
    const current = await setupCreate();
    const { dialog } = await openAndFill(current);
    await firstAction(current, dialog);
    expect(within(dialog).getByRole("heading", { name: "생성 내용 검토" })).toBeVisible();
    expect(dialog).toHaveTextContent("사용");
    await invoke(current.capture("규칙 만들기"));
    expect(current.count(createPath)).toBe(0);
    expectOnlyCreate(current);
  });

  it("열린 생성창에서 쓰기 권한을 회수하면 실제 제출도 POST 하지 않는다", async () => {
    const current = await setupCreate();
    const { dialog } = await openAndFill(current);
    current.update({ scopes: ["routing:read"] });
    expect(screen.getByTestId("create-access")).toHaveTextContent("routing.rules:false:routing.rules");
    expect(dialog).toBeInTheDocument();
    await firstAction(current, dialog);
    expect(current.count(createPath)).toBe(0);
    expectOnlyCreate(current);
  });

  it("열린 생성창이 실제 읽기 전용으로 바뀌면 POST 하지 않는다", async () => {
    const current = await setupCreate();
    const { dialog } = await openAndFill(current);
    current.update({ readOnly: true });
    expect(screen.getByTestId("create-access")).toHaveTextContent("routing.rules:true:routing.rules");
    expect(dialog).toBeInTheDocument();
    await firstAction(current, dialog);
    expect(current.count(createPath)).toBe(0);
    expectOnlyCreate(current);
  });

  it("서버 반영 뒤 빈 ACK는 성공 toast나 자동 닫기로 처리하지 않는다", async () => {
    const current = await setupCreate();
    current.response.create = () => ({});
    const { dialog } = await openAndFill(current);
    await reviewAndAgree(current, dialog);
    await createAndSettle(current, dialog);
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(current.records.size).toBe(1);
    expect(createToasts().success).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expectOnlyCreate(current);
  });
});

describe("생성할 값의 검토와 현재 승인", () => {
  it("입력 수정 후 옛 저장 callback은 쓰지 않고 현재 검토의 수정된 본문만 보낸다", async () => {
    const current = await setupCreate();
    const { dialog, captured } = await approved(current);
    await current.user.click(within(dialog).getByRole("button", { name: "입력 수정" }));
    await editField(current, dialog, "메모", "새로 검토한 공개 메모");
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    await reviewAndAgree(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
    expect(current.calls.find((call) => call.key === createPath)?.body).toEqual({
      ...submittedRule,
      note: "새로 검토한 공개 메모",
    });
  });

  it.each([
    ["쓰기 권한", { scopes: ["routing:read"] }, { scopes: ["routing:read", "routing:write"] }],
    ["읽기 전용", { readOnly: true }, { readOnly: false }],
    [
      "표시 보호 기준",
      { prefixes: ["vc_sk_", "vc_sa_", "custom_private_"] },
      { prefixes: ["vc_sk_", "vc_sa_"] },
    ],
  ])("%s A→B→A는 이전 동의를 복구하지 않고 초안과 현재 재검토만 유지한다", async (_label, next, restore) => {
    const current = await setupCreate();
    const { dialog, captured } = await approved(current);
    current.update(next);
    expect(dialog).toBeInTheDocument();
    current.update(restore);
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    await current.user.click(within(dialog).getByRole("button", { name: "입력 수정" }));
    expect(within(dialog).getByLabelText(/대상 모델/u)).toHaveValue(submittedRule.target_model);
    await reviewAndAgree(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("생성은 실제 부모 목록의 정상 재조회와 pending 세대를 승인 전제로 삼지 않는다", async () => {
    const current = await setupCreate();
    const query = current.actualListQuery();
    const before = current.count(listPath);
    await act(async () => {
      await query.fetch();
    });
    expect(current.count(listPath)).toBe(before + 1);
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = query.fetch().catch(() => undefined);
    });
    await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
    try {
      const { dialog } = await approved(current);
      current.response.read = undefined;
      await createAndSettle(current, dialog);
      expect(current.count(createPath)).toBe(1);
      expect(createToasts().success).toHaveBeenCalledWith(successMessage);
      expect(query.state.data).toEqual({ rules: [...current.records.values()] });
    } finally {
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [] });
        await pending;
      });
    }
    // The pre-create old read cannot overwrite the current post-ACK list.
    expect(query.state.data).toEqual({ rules: [...current.records.values()] });
  });

  it.each([
    ["빈 우선순위", "우선순위", ""],
    ["소수 복잡도", "최소 복잡도", "10.5"],
    ["역전 범위", "최소 복잡도", "90"],
    ["안전 정수 밖", "우선순위", "9007199254740992"],
  ])(
    "%s는 검토·POST를 진행하지 않고 실제 오류 입력으로 초점을 이동한다",
    async (_label, fieldLabel, value) => {
      const current = await setupCreate();
      const { dialog } = await openAndFill(current);
      const field = await editField(current, dialog, fieldLabel, value);
      await firstAction(current, dialog);
      await waitFor(() => expect(field).toHaveFocus());
      expect(within(dialog).queryByRole("heading", { name: "생성 내용 검토" })).not.toBeInTheDocument();
      expect(current.count(createPath)).toBe(0);
    },
  );

  it("취소에서 계속 편집은 초안을 유지하고 명시 폐기만 닫아 현재 추가 버튼으로 복귀한다", async () => {
    const current = await setupCreate();
    const { dialog } = await openAndFill(current);
    await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
    const confirmation = await screen.findByRole("alertdialog");
    await current.user.click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(within(dialog).getByLabelText(/메모/u)).toHaveValue(submittedRule.note);
    await discard(current, dialog);
    await waitFor(() => expect(screen.getByRole("button", { name: /규칙 추가/u })).toHaveFocus());
    expect(current.count(createPath)).toBe(0);
  });
});

describe("확인된 생성과 불명확 응답을 구분한다", () => {
  it.each([
    ["필수 rule 누락", () => ({})],
    ["빈 ID", (rule: typeof submittedRule) => ({ rule: { ...rule, id: "" } })],
    ["검토와 다른 값", (rule: typeof submittedRule) => ({ rule: { ...rule, priority: 71 } })],
  ])("%s 뒤 동일 창은 수동 GET이 빈 목록을 반환해도 다시 POST하지 않는다", async (_label, reply) => {
    const current = await setupCreate();
    current.response.create = reply;
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(current.records.size).toBe(1);
    // Even an empty current list cannot prove that a timed-out POST won't finish.
    current.records.clear();
    const reads = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    expect(current.count(listPath)).toBe(reads + 1);
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    await invoke(captured);
    await invoke(current.capture("규칙 만들기"));
    expect(current.count(createPath)).toBe(1);
    expect(createToasts().success).not.toHaveBeenCalled();
    expectOnlyCreate(current);
  });

  it("전송 후 HTTP 오류와 수동 조회 실패는 미확정 상태를 유지하고 요청 ID 원문을 숨긴다", async () => {
    const current = await setupCreate();
    const marker = `vc_sk_${"s".repeat(48)}`;
    const failure = () => {
      throw new AppError("합성 오류", { kind: "http", status: 503, requestId: marker });
    };
    current.response.create = failure;
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    current.response.read = failure;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    await invoke(captured);
    expect(current.count(createPath)).toBe(1);
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(document.body.outerHTML).not.toContain(marker);
    expect(createToasts().success).not.toHaveBeenCalled();
  });

  it("실제 zero-time ACK 뒤 GET 실패는 생성 실패가 아니며 수동 GET만 복구한다", async () => {
    const current = await setupCreate();
    current.response.create = (rule) => {
      expect(rule.created_at).toBe(zeroCreatedAt);
      current.response.read = () => {
        throw new AppError("합성 후속 오류", { kind: "http", status: 503 });
      };
      return { rule };
    };
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    expect(within(dialog).getByText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.")).toBeVisible();
    expect(within(dialog).queryByText("생성 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(createToasts().success).toHaveBeenCalledWith(successMessage);
    await invoke(captured);
    current.response.read = undefined;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    expect(current.actualListQuery().state.data).toEqual({ rules: [...current.records.values()] });
    expect(current.count(createPath)).toBe(1);
    expect(createToasts().success).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["write 회수", { scopes: ["routing:read"] }],
    ["읽기 전용", { readOnly: true }],
  ])("전송 뒤 %s되어도 현재 read의 유효 ACK는 성공이고 동기 중복은 POST1이다", async (_label, update) => {
    const current = await setupCreate();
    const held = deferred<unknown>();
    let reply: unknown;
    current.response.create = (rule) => {
      reply = { rule };
      return held.promise;
    };
    const { dialog, captured } = await approved(current);
    await act(async () => {
      void captured();
      void captured();
      await Promise.resolve();
    });
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    current.update(update);
    await invoke(captured);
    await act(async () => {
      held.resolve(reply);
    });
    await manualSettled(dialog);
    expect(createToasts().success).toHaveBeenCalledWith(successMessage);
    expect(within(dialog).queryByText("생성 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(1);
  });
});

describe("생성창·현재 주체의 요청 수명", () => {
  it.each([
    ["계정", { userId: "operator-b" }, { userId: "operator-a" }],
    ["팀", { teamId: "team-b" }, { teamId: "team-a" }],
    ["소유 기능", { owner: "routing.preview" }, { owner: "routing.rules" }],
    ["인증 모드", { mode: "legacy" as const }, { mode: "authenticated" as const }],
    ["읽기 권한", { scopes: ["routing:write"] }, { scopes: ["routing:read", "routing:write"] }],
    ["기능 접근", { permitted: false }, { permitted: true }],
  ])("%s A→B→A는 옛 창과 callback을 폐기하고 새 입력·검토만 허용한다", async (_label, next, restore) => {
    const current = await setupCreate();
    const { dialog, captured } = await approved(current);
    const refresh = current.capture("목록 다시 조회");
    current.update(next);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    current.update(restore);
    await screen.findByRole("button", { name: /규칙 추가/u });
    await waitFor(() => expect(current.actualListQuery().state.fetchStatus).toBe("idle"));
    const reads = current.count(listPath);
    await invoke(captured);
    await invoke(refresh);
    expect(current.count(createPath)).toBe(0);
    expect(current.count(listPath)).toBe(reads);
    const second = await approved(current);
    await createAndSettle(current, second.dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("session epoch 변경은 전송 전 옛 callback을 새 인증으로 실행하지 않는다", async () => {
    const current = await setupCreate();
    const { dialog, captured } = await approved(current);
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    expect(createToasts().success).not.toHaveBeenCalled();
  });

  it("전송한 POST의 늦은 ACK는 새 주체의 실제 목록·성공 알림을 바꾸지 않는다", async () => {
    const current = await setupCreate();
    const held = deferred<unknown>();
    let reply: unknown;
    current.response.create = (rule) => {
      reply = { rule };
      return held.promise;
    };
    const { dialog, captured } = await approved(current);
    await invoke(captured);
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // Existing parent key is epoch+feature, not principal. Establish B through
    // its actual Query before isolating this new operation's late-publication fence.
    current.records.clear();
    const before = current.count(listPath);
    await act(async () => {
      await current.actualListQuery().fetch();
    });
    expect(current.count(listPath)).toBe(before + 1);
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    const reads = current.count(listPath);
    await act(async () => {
      held.resolve(reply);
    });
    expect(current.count(listPath)).toBe(reads);
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    expect(createToasts().success).not.toHaveBeenCalled();
    expect(current.count(createPath)).toBe(1);
  });

  it("확정 ACK 이후 늦은 GET은 새 주체가 실제 조회한 목록을 덮지 않는다", async () => {
    const current = await setupCreate();
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const { dialog, captured } = await approved(current);
    const before = current.count(listPath);
    await invoke(captured);
    await waitFor(() => expect(current.count(listPath)).toBe(before + 1));
    expect(createToasts().success).toHaveBeenCalledWith(successMessage);
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    current.response.read = undefined;
    const oldRows = [...current.records.values()];
    current.records.clear();
    await act(async () => {
      await current.actualListQuery().fetch();
    });
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    const reads = current.count(listPath);
    const toasts = createToasts().success.mock.calls.length;
    await act(async () => {
      held.resolve({ rules: oldRows });
    });
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    expect(current.count(listPath)).toBe(reads);
    expect(createToasts().success).toHaveBeenCalledTimes(toasts);
    expect(current.count(createPath)).toBe(1);
  });

  it("폐기한 창의 captured 저장·조회·취소는 새 창을 건드리지 않는다", async () => {
    const current = await setupCreate();
    const first = await approved(current);
    const close = current.capture("취소");
    const refresh = current.capture("목록 다시 조회");
    await discard(current, first.dialog);
    const second = await approved(current);
    const reads = current.count(listPath);
    await invoke(first.captured);
    await invoke(refresh);
    await invoke(close);
    expect(second.dialog).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(0);
    expect(current.count(listPath)).toBe(reads);
  });
});

describe("생성 검토 전환 뒤 키보드 초점", () => {
  it("입력 수정으로 검토 버튼이 사라지면 첫 입력으로 초점을 돌린다", async () => {
    const current = await setupCreate();
    const { dialog } = await approved(current);
    await current.user.click(within(dialog).getByRole("button", { name: "입력 수정" }));
    const first = within(dialog).getByLabelText(/모델 패턴/u);
    expect(first).toHaveValue(submittedRule.match_pattern);
    await waitFor(() => expect(first).toHaveFocus());
    expect(current.count(createPath)).toBe(0);
  });

  it("ACK 후 성공 결과로 한 번 초점을 옮기며 늦은 GET·수동 조회가 초점을 다시 빼앗지 않는다", async () => {
    const current = await setupCreate();
    const { dialog, action } = await approved(current);
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const reads = current.count(listPath);
    await current.user.click(action);
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    expect(current.count(createPath)).toBe(1);
    expect(within(dialog).getByText(successMessage)).toBeVisible();
    try {
      // This first assertion checks the actual lost-focus behavior before the
      // new named-region lookup; missing future UI is not a setup-only RED.
      await waitFor(() => expect(document.activeElement).toHaveAttribute("role", "region"));
      const result = within(dialog).getByRole("region", { name: "라우팅 규칙 생성 결과" });
      expect(result).toHaveFocus();
      const refresh = within(dialog).getByRole("button", { name: "목록 다시 조회" });
      act(() => refresh.focus());
      expect(refresh).toHaveFocus();
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [...current.records.values()] });
      });
      await manualSettled(dialog);
      expect(refresh).toHaveFocus();
      const beforeManual = current.count(listPath);
      await current.user.click(refresh);
      await manualSettled(dialog);
      expect(current.count(listPath)).toBe(beforeManual + 1);
      expect(refresh).toHaveFocus();
      expect(current.count(createPath)).toBe(1);
    } finally {
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [...current.records.values()] });
      });
    }
  });
});
