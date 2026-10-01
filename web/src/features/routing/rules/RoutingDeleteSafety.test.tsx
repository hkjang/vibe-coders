import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import {
  acknowledgeIfPresent,
  confirmDelete,
  deferred,
  deleteToasts,
  expectOnlyDelete,
  listPath,
  openDelete,
  setupDelete,
  type DeleteHarness,
} from "./routing-delete-test-harness";

async function approved(current: DeleteHarness) {
  const opened = await openDelete(current);
  await acknowledgeIfPresent(current, opened.dialog);
  const action = within(opened.dialog).getByRole("button", { name: "규칙 삭제" });
  expect(action).toHaveAttribute("aria-disabled", "false");
  return { ...opened, action, captured: current.capture("규칙 삭제") };
}
function ownQuery(current: DeleteHarness) {
  const queries = current.view.client
    .getQueryCache()
    .findAll()
    .filter((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "delete-review");
  expect(queries).toHaveLength(1);
  const query = queries[0];
  if (!query) throw new Error("Actual mounted delete Query missing");
  return query;
}
async function invoke(callback: (event?: unknown) => unknown) {
  await act(async () => {
    void callback();
    await Promise.resolve();
  });
}
async function retype(current: DeleteHarness, dialog: HTMLElement) {
  const input = within(dialog).getByRole("textbox", { name: "삭제 확인 문구" });
  await current.user.clear(input);
  await current.user.type(input, "규칙 삭제");
  const active = within(dialog).queryByRole("checkbox", {
    name: "사용 중인 규칙의 라우팅 영향을 확인했습니다",
  });
  if (active && !(active as HTMLInputElement).checked) await current.user.click(active);
}
async function manualSettled(current: DeleteHarness, dialog: HTMLElement) {
  await waitFor(() => {
    const refresh = within(dialog).getByRole("button", { name: "목록 다시 조회" });
    expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(refresh).toHaveAttribute("aria-disabled", "false");
    expect(ownQuery(current).state.fetchStatus).toBe("idle");
  });
}

describe("라우팅 삭제의 실제 확인 콜백 경계", () => {
  it("실제 FeatureRoute·목록·확인창에서 같은 ID만 본문 없이 한 번 삭제한다", async () => {
    const current = await setupDelete();
    const { dialog } = await openDelete(current);
    await acknowledgeIfPresent(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
    expect(current.calls.find((call) => call.key === current.deletePath)?.body).toBeUndefined();
    expect(current.records.has(current.rule.id)).toBe(false);
    expectOnlyDelete(current);
  });

  it.each([
    ["쓰기 권한 회수", { scopes: ["routing:read"] }],
    ["기능 읽기 전용 전환", { readOnly: true }],
  ] as const)("열린 확인창에서 %s되면 실제 삭제를 보내지 않는다", async (_label, update) => {
    const current = await setupDelete();
    const { dialog } = await openDelete(current);
    await acknowledgeIfPresent(current, dialog);
    current.update("scopes" in update ? { scopes: [...update.scopes] } : { readOnly: update.readOnly });
    await confirmDelete(current, dialog);
    expect(current.count(current.deletePath)).toBe(0);
    expect(current.records.has(current.rule.id)).toBe(true);
    expectOnlyDelete(current);
  });

  it("확인 후 서버 원본이 바뀌면 새 원본을 삭제하지 않는다", async () => {
    const current = await setupDelete();
    const { dialog } = await openDelete(current);
    await acknowledgeIfPresent(current, dialog);
    current.records.set(current.rule.id, { ...current.rule, target_model: "second-writer-model" });
    await confirmDelete(current, dialog);
    expect(current.count(current.deletePath)).toBe(0);
    expect(current.records.get(current.rule.id)?.target_model).toBe("second-writer-model");
    expectOnlyDelete(current);
  });

  it("목록에서 보호한 기존 모델 원문을 삭제 설명이나 접근성 DOM에 다시 노출하지 않는다", async () => {
    const secret = `vc_sk_${"s".repeat(48)}`;
    const current = await setupDelete({ target_model: secret });
    expect(document.body.outerHTML).not.toContain(secret);
    const { dialog } = await openDelete(current);
    expect(screen.getByRole("dialog", { name: "라우팅 규칙 삭제" })).toBe(dialog);
    expect(document.body.outerHTML).not.toContain(secret);
    expect(current.count(current.deletePath)).toBe(0);
  });
});

describe("삭제 대상 검토와 확정 결과", () => {
  it("초기 strict GET이 대기하면 확인 입력을 잠그고 정상 원본을 받은 뒤에만 입력·삭제한다", async () => {
    const current = await setupDelete();
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const reads = current.count(listPath);
    await current.user.click(screen.getByRole("button", { name: / 규칙 삭제$/u }));
    const dialog = await screen.findByRole("dialog", { name: "라우팅 규칙 삭제" });
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    const input = within(dialog).getByRole("textbox", { name: "삭제 확인 문구" });
    const active = within(dialog).getByRole("checkbox", {
      name: "사용 중인 규칙의 라우팅 영향을 확인했습니다",
    });
    try {
      expect(ownQuery(current).state.fetchStatus).toBe("fetching");
      expect(input).toHaveAttribute("readonly");
      expect(active).toBeDisabled();
      await current.user.type(input, "규칙 삭제");
      expect(input).toHaveValue("");
      await invoke(current.capture("규칙 삭제"));
      expect(current.count(current.deletePath)).toBe(0);
    } finally {
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [current.rule] });
      });
    }
    await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
    expect(active).toBeEnabled();
    await acknowledgeIfPresent(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
    expectOnlyDelete(current);
  });

  it("정확한 확인 문구와 사용 중 영향 확인 전에는 직접 실제 callback을 호출해도 삭제하지 않는다", async () => {
    const current = await setupDelete();
    const { dialog } = await openDelete(current);
    const input = within(dialog).getByRole("textbox", { name: "삭제 확인 문구" });
    const active = within(dialog).getByRole("checkbox", {
      name: "사용 중인 규칙의 라우팅 영향을 확인했습니다",
    });
    const action = within(dialog).getByRole("button", { name: "규칙 삭제" });
    expect(action).toHaveAttribute("aria-disabled", "true");
    await current.user.type(input, "규칙 삭제 ");
    await current.user.click(active);
    await invoke(current.capture("규칙 삭제"));
    expect(current.count(current.deletePath)).toBe(0);
    await current.user.clear(input);
    await current.user.type(input, "규칙 삭제");
    await current.user.click(active);
    await invoke(current.capture("규칙 삭제"));
    expect(current.count(current.deletePath)).toBe(0);
    await current.user.click(active);
    expect(action).toHaveAttribute("aria-disabled", "false");
    await current.user.click(action);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
  });

  it("중지된 규칙에는 활성 영향 checkbox를 요구하지 않고 같은 ID를 삭제한다", async () => {
    const current = await setupDelete({ enabled: false });
    const { dialog } = await openDelete(current);
    expect(
      within(dialog).queryByRole("checkbox", { name: "사용 중인 규칙의 라우팅 영향을 확인했습니다" }),
    ).not.toBeInTheDocument();
    await retype(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
    expectOnlyDelete(current);
  });

  it("취소는 DELETE하지 않고 현재 행의 삭제 버튼으로 초점을 돌려준다", async () => {
    const current = await setupDelete();
    const { dialog } = await openDelete(current);
    await acknowledgeIfPresent(current, dialog);
    await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: / 규칙 삭제$/u })).toHaveFocus());
    expect(current.count(current.deletePath)).toBe(0);
  });

  it("원본 확인 GET이 실패하거나 엄격 필드가 없으면 실제 삭제를 시작하지 않는다", async () => {
    const current = await setupDelete();
    const { note: omitted, ...missing } = current.rule;
    expect(omitted).toBeDefined();
    current.response.read = () => ({ rules: [missing] });
    const { dialog } = await openDelete(current);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "규칙 삭제" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await invoke(current.capture("규칙 삭제"));
    expect(current.count(current.deletePath)).toBe(0);
    current.response.read = undefined;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(ownQuery(current).state.status).toBe("success"));
    await manualSettled(current, dialog);
    await retype(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
  });

  it.each([
    ["빈 ACK", {}],
    ["다른 ID", { id: "another-rule", status: "deleted" }],
    ["다른 상태", { id: "route_delete_a", status: "pending" }],
  ])("%s는 성공으로 오인하지 않고 수동 GET 뒤에도 같은 창의 재삭제를 영구 차단한다", async (_name, ack) => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    current.response.remove = () => ack;
    await confirmDelete(current, dialog);
    expect(await screen.findByText("삭제 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(current.count(current.deletePath)).toBe(1);
    expect(current.records.has(current.rule.id)).toBe(false);
    // Even the original row returning again is NOT proof the prior request
    // cannot finish late. Manual equality must not unlock this same dialog.
    current.records.set(current.rule.id, { ...current.rule });
    const reads = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.count(listPath)).toBeGreaterThan(reads));
    await manualSettled(current, dialog);
    await invoke(captured);
    await invoke(current.capture("규칙 삭제"));
    expect(within(dialog).getByRole("button", { name: "규칙 삭제" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(current.count(current.deletePath)).toBe(1);
    expect(deleteToasts().success).not.toHaveBeenCalled();
  });

  it("전송 후 HTTP 오류와 실패한 수동 조회도 미확정 잠금을 해제하지 않는다", async () => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    current.response.remove = () => {
      throw new AppError("합성 연결 오류", { kind: "http", status: 503 });
    };
    await confirmDelete(current, dialog);
    expect(await screen.findByText("삭제 여부를 확인하지 못했습니다.")).toBeVisible();
    current.response.read = () => {
      throw new AppError("합성 조회 오류", { kind: "http", status: 503 });
    };
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(current, dialog);
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(1);
    expect(dialog).toHaveTextContent("삭제 여부를 확인하지 못했습니다.");
  });

  it("확인된 ACK 뒤 GET 실패는 삭제 실패가 아니며 재조회만 한다", async () => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    current.response.remove = () => {
      current.response.read = () => {
        throw new AppError("합성 후속 조회 오류", { kind: "http", status: 503 });
      };
      return { id: current.rule.id, status: "deleted" };
    };
    await confirmDelete(current, dialog);
    expect(await screen.findByText("삭제 요청은 확인했지만 목록을 다시 조회하지 못했습니다.")).toBeVisible();
    expect(screen.queryByText("삭제 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    await invoke(captured);
    current.response.read = undefined;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.actualListQuery().state.data).toEqual({ rules: [] }));
    await manualSettled(current, dialog);
    expect(current.count(current.deletePath)).toBe(1);
    expectOnlyDelete(current);
  });

  it("전송된 DELETE가 대기하는 동안 중복 callback을 막고 write 회수 뒤 유효 ACK를 미확정으로 바꾸지 않는다", async () => {
    const current = await setupDelete();
    const held = deferred<unknown>();
    current.response.remove = () => held.promise;
    const { dialog, captured } = await approved(current);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
    await invoke(captured);
    current.update({ scopes: ["routing:read"] });
    await act(async () => {
      held.resolve({ id: current.rule.id, status: "deleted" });
    });
    expect(await screen.findByText("라우팅 규칙 삭제 요청을 확인했습니다.")).toBeVisible();
    expect(screen.queryByText("삭제 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(current.count(current.deletePath)).toBe(1);
  });
});

describe("삭제 확인의 현재 권한·조회 세대", () => {
  it("저장 직전 GET 대기 중 중복 click과 권한 회수는 DELETE를 보내지 않는다", async () => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const reads = current.count(listPath);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    await invoke(captured);
    expect(current.count(listPath)).toBe(reads + 1);
    current.update({ readOnly: true });
    await act(async () => {
      held.resolve({ rules: [current.rule] });
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    expect(current.count(current.deletePath)).toBe(0);
  });

  it("write 회수·복구 왕복은 옛 확인을 부활시키지 않으며 재입력한 현재 확인만 허용한다", async () => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    current.update({ scopes: ["routing:read"] });
    current.update({ scopes: ["routing:read", "routing:write"] });
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(0);
    expect(within(dialog).getByRole("button", { name: "규칙 삭제" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await retype(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
  });

  it.each([
    ["계정", { userId: "operator-b" }, { userId: "operator-a" }],
    ["팀", { teamId: "team-b" }, { teamId: "team-a" }],
    ["기능 소유자", { owner: "routing.preview" }, { owner: "routing.rules" }],
    ["인증 모드", { mode: "legacy" as const }, { mode: "authenticated" as const }],
  ])("%s A→B→A 전환 뒤 옛 삭제·조회 callback은 새 화면에 요청하지 않는다", async (_label, next, restore) => {
    const current = await setupDelete();
    const { captured } = await approved(current);
    const refresh = current.capture("목록 다시 조회");
    current.update(next);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument(),
    );
    current.update(restore);
    await screen.findByRole("button", { name: / 규칙 삭제$/u });
    await waitFor(() => expect(current.actualListQuery().state.fetchStatus).toBe("idle"));
    const reads = current.count(listPath);
    await invoke(captured);
    await invoke(refresh);
    expect(current.count(listPath)).toBe(reads);
    expect(current.count(current.deletePath)).toBe(0);
    await approved(current);
  });

  it("read 회수 뒤 옛 확인과 늦은 원본 조회를 폐기하고 복구는 새 선택으로만 한다", async () => {
    const current = await setupDelete();
    const { captured } = await approved(current);
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const query = ownQuery(current);
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = query.fetch().catch(() => undefined);
    });
    await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
    current.update({ scopes: [] });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument(),
    );
    await act(async () => {
      held.resolve({ rules: [{ ...current.rule, note: "late-old-read" }] });
      await pending;
    });
    current.response.read = undefined;
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(0);
    expect(document.body.textContent).not.toContain("late-old-read");
    current.update({ scopes: ["routing:read", "routing:write"] });
    await screen.findByRole("button", { name: / 규칙 삭제$/u });
    await approved(current);
  });

  it("session epoch가 바뀐 뒤 captured 삭제 callback은 새 인증으로 보내지 않는다", async () => {
    const current = await setupDelete();
    const { captured } = await approved(current);
    act(() => tokenStore.clearAll());
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(0);
    expect(deleteToasts().success).not.toHaveBeenCalled();
  });

  it("이미 보낸 DELETE의 늦은 ACK는 새 계정의 목록·창·성공 알림을 갱신하지 않는다", async () => {
    const current = await setupDelete();
    const held = deferred<unknown>();
    current.response.remove = () => held.promise;
    const { dialog } = await approved(current);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // Existing parent identity is epoch+feature owner, not principal. Explicitly
    // establish B's real current list before testing the retired DELETE response.
    const beforeRefresh = current.count(listPath);
    await act(async () => {
      await current.actualListQuery().fetch();
    });
    expect(current.count(listPath)).toBe(beforeRefresh + 1);
    await waitFor(() => expect(current.actualListQuery().state.data).toEqual({ rules: [] }));
    const reads = current.count(listPath);
    await act(async () => {
      held.resolve({ id: current.rule.id, status: "deleted" });
    });
    expect(current.count(listPath)).toBe(reads);
    expect(current.count(current.deletePath)).toBe(1);
    expect(deleteToasts().success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument();
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
  });

  it("current-prefix 변경은 기존 승인을 폐기하고 설명과 요청 ID 원문도 표시하지 않는다", async () => {
    const secret = `private_delete_${"s".repeat(48)}`;
    const current = await setupDelete({ target_provider: secret });
    const { dialog, captured } = await approved(current);
    current.update({ prefixes: ["vc_sk_", "vc_sa_", "private_delete_"] });
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(0);
    expect(document.body.outerHTML).not.toContain(secret);
    current.response.read = () => {
      throw new AppError("합성 조회 오류", { kind: "http", status: 503, requestId: secret });
    };
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(current, dialog);
    expect(document.body.outerHTML).not.toContain(secret);
    expect(current.count(current.deletePath)).toBe(0);
  });

  it("실제 부모 목록이 fetching이면 React 통지 전 captured 행 callback도 삭제창을 열지 않는다", async () => {
    const current = await setupDelete();
    const query = current.actualListQuery();
    const before = current.count(listPath);
    await act(async () => {
      await query.fetch();
    });
    expect(current.count(listPath)).toBe(before + 1);
    const trigger = screen.getByRole("button", { name: / 규칙 삭제$/u });
    expect(trigger).toBeEnabled();
    const open = current.capture(trigger.getAttribute("aria-label") ?? "");
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = query.fetch().catch(() => undefined);
      expect(query.state.fetchStatus).toBe("fetching");
      void open({ currentTarget: trigger });
    });
    expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument();
    current.response.read = undefined;
    await act(async () => {
      held.resolve({ rules: [current.rule] });
      await pending;
    });
    await approved(current);
    expect(current.count(current.deletePath)).toBe(0);
  });

  it("실제 부모 Query의 데이터 A→B→A 왕복은 옛 행 callback의 선택 승인을 복구하지 않는다", async () => {
    const current = await setupDelete();
    const trigger = screen.getByRole("button", { name: / 규칙 삭제$/u });
    const open = current.capture(trigger.getAttribute("aria-label") ?? "");
    const query = current.actualListQuery();
    const count = query.state.dataUpdateCount;
    act(() => {
      current.view.client.setQueryData(query.queryKey, {
        rules: [{ ...current.rule, note: "another-generation" }],
      });
      current.view.client.setQueryData(query.queryKey, { rules: [{ ...current.rule }] });
      expect(query.state.dataUpdateCount).toBe(count + 2);
      void open({ currentTarget: trigger });
    });
    expect(screen.queryByRole("dialog", { name: "라우팅 규칙 삭제" })).not.toBeInTheDocument();
    expect(current.count(current.deletePath)).toBe(0);
    await approved(current);
  });

  it("실제 삭제 Query fetching은 React 통지 전 captured 수동조회·삭제를 막는다", async () => {
    const current = await setupDelete();
    const { dialog } = await approved(current);
    const query = ownQuery(current);
    const first = current.count(listPath);
    await act(async () => {
      await query.fetch();
    });
    expect(current.count(listPath)).toBe(first + 1);
    await retype(current, dialog);
    expect(within(dialog).getByRole("button", { name: "규칙 삭제" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    const captured = current.capture("규칙 삭제");
    const refresh = current.capture("목록 다시 조회");
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const before = current.count(listPath);
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = query.fetch().catch(() => undefined);
      expect(query.state.fetchStatus).toBe("fetching");
      void refresh();
      void captured();
      await Promise.resolve();
    });
    expect(current.count(listPath)).toBe(before + 1);
    expect(current.count(current.deletePath)).toBe(0);
    current.response.read = undefined;
    await act(async () => {
      held.resolve({ rules: [current.rule] });
      await pending;
    });
  });

  it("수동 GET의 동일 원본도 이전 승인을 재사용하지 않고 문구를 다시 입력해야 한다", async () => {
    const current = await setupDelete();
    const { dialog, captured } = await approved(current);
    const reads = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    await manualSettled(current, dialog);
    expect(within(dialog).getByRole("button", { name: "규칙 삭제" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await invoke(captured);
    expect(current.count(current.deletePath)).toBe(0);
    await retype(current, dialog);
    await confirmDelete(current, dialog);
    await waitFor(() => expect(current.count(current.deletePath)).toBe(1));
  });

  it("닫힌 A의 captured 취소·삭제·조회는 같은 ID의 새 B 확인창을 건드리지 않는다", async () => {
    const current = await setupDelete();
    const first = await approved(current);
    const close = current.capture("취소");
    const refresh = current.capture("목록 다시 조회");
    await current.user.click(within(first.dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(first.dialog).not.toBeInTheDocument());
    const second = await approved(current);
    const reads = current.count(listPath);
    await invoke(close);
    await invoke(refresh);
    await invoke(first.captured);
    expect(second.dialog).toBeInTheDocument();
    expect(current.count(listPath)).toBe(reads);
    expect(current.count(current.deletePath)).toBe(0);
  });
});
