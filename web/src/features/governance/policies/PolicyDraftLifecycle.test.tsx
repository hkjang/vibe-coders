import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { acknowledgement, advice, applyPath, deferred, setupDraft } from "./policy-draft-test-harness";

describe("초안 검토의 고정 기준과 수동 복구", () => {
  it("원래 조회 객체가 나중에 바뀌어도 전송할 깊은 규칙은 고정한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const row = c.response.rows[0];
    if (!row || !row.conditions) throw new Error("missing fixture");
    row.conditions.model = "unexecuted-b";
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toEqual([
      { title: advice.title, conditions: advice.conditions, actions: advice.actions },
    ]);
  });
  it("새 조회가 추천ID를 재발급해도 원래 A를 유지하고 명시 재확인만 허용한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const old = c.capture();
    c.response.rows = [
      { ...structuredClone(advice), id: "new-id", title: "새 추천 B", conditions: { model: "model-b" } },
    ];
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
    });
    await waitFor(() => expect(c.confirm()).toBeDisabled());
    expect(c.dialog()).toHaveTextContent(advice.title ?? "");
    expect(c.dialog()).not.toHaveTextContent("새 추천 B");
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    await act(async () => old());
    expect(c.api.bodies(applyPath)).toEqual([]);
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toEqual([
      { title: advice.title, conditions: advice.conditions, actions: advice.actions },
    ]);
  });
  it("읽기 전용 복구 후 기존 승인은 폐기하고 수동 재확인을 요구한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const old = c.capture();
    c.update({ mode: "read_only" });
    expect(c.dialog()).toBeVisible();
    c.update({ mode: "writable" });
    expect(c.confirm()).toBeDisabled();
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    await act(async () => old());
    expect(c.api.bodies(applyPath)).toEqual([]);
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toHaveLength(1);
  });
  it("닫힌 검토의 확인 콜백은 이후 새 창에 사용하지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const old = c.capture();
    await c.user.click(within(c.dialog()).getByRole("button", { name: "취소" }));
    await c.user.click(c.button());
    await act(async () => old());
    expect(c.api.bodies(applyPath)).toEqual([]);
    expect(c.dialog()).toBeVisible();
  });
  it("추천 조회 실패를 창 안에서 수동 복구해도 자동 생성하지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.response.suggestions = () => {
      throw new AppError("synthetic", { kind: "http", status: 503 });
    };
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
    });
    await waitFor(() => expect(c.confirm()).toBeDisabled());
    await c.user.click(within(c.dialog()).getByRole("button", { name: "목록 다시 조회" }));
    expect(await within(c.dialog()).findByText(/추천 목록을 갱신하지 못했습니다/u)).toBeVisible();
    c.response.suggestions = () => ({ suggestions: [{ ...advice, id: "reissued-public" }] });
    await c.user.click(within(c.dialog()).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" })).toBeEnabled(),
    );
    expect(c.confirm()).toBeDisabled();
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    expect(c.api.bodies(applyPath)).toEqual([]);
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toHaveLength(1);
  });
  it("목록 조회용 admin:read 회수는 새 GET을 차단하며 생성 권한과 분리한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ scopes: ["security:read", "admin:write"] });
    expect(c.confirm()).toBeEnabled();
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toHaveLength(1);
  });
  it("재발급된 목록 뒤 과거 행 열기 callback은 옛 추천으로 열지 않는다", async () => {
    const c = await setupDraft();
    const old = c.capture("open");
    c.response.rows = [{ ...advice, id: "new-row", title: "새 목록" }];
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
    });
    await screen.findByText("새 목록");
    await act(async () => old());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("응답·중복·후속 조회의 별도 수명", () => {
  it("확정 생성 뒤 과거 콜백은 재생성하지 않고 후속 GET 실패는 성공으로 유지한다", async () => {
    const c = await setupDraft();
    c.response.policies = () => {
      throw new AppError("synthetic", { kind: "http", status: 503 });
    };
    await c.user.click(c.button());
    const old = c.capture();
    await c.user.click(c.confirm());
    await screen.findByText("비활성 정책 초안을 생성했습니다.");
    await screen.findByText(/생성은 확인했지만 정책 목록을 갱신하지 못했습니다/u);
    await act(async () => old());
    expect(c.api.bodies(applyPath)).toHaveLength(1);
    c.response.policies = () => ({ policies: [] });
    await c.user.click(screen.getByRole("button", { name: "정책 목록 다시 조회" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/생성은 확인했지만 정책 목록을 갱신하지 못했습니다/u),
      ).not.toBeInTheDocument(),
    );
    expect(c.api.bodies(applyPath)).toHaveLength(1);
  });
  it("확정 후 지연 GET 중 닫기는 즉시 작동하고 늦은 실패는 무시한다", async () => {
    const c = await setupDraft();
    const held = deferred<unknown>();
    c.response.policies = () => held.promise;
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    await screen.findByText("비활성 정책 초안을 생성했습니다.");
    await c.user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => held.reject(new Error("public delayed error")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(c.api.bodies(applyPath)).toHaveLength(1);
    await waitFor(() => expect(c.button()).toHaveFocus());
  });
  it("물리 연속 클릭과 pending닫기는 추가 POST나 창 폐기를 만들지 않는다", async () => {
    const c = await setupDraft();
    const held = deferred<typeof acknowledgement>();
    c.response.apply = () => held.promise;
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    const pending = within(c.dialog()).getByRole("button", { name: "생성 중" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveFocus();
    await c.user.click(pending);
    await c.user.keyboard("{Enter}{Escape}");
    expect(c.dialog()).toBeVisible();
    expect(c.api.bodies(applyPath)).toHaveLength(1);
    await act(async () => held.resolve(acknowledgement));
  });
  it("실패 후 명시 재시도만 원래 POST를 다시 보낸다", async () => {
    const c = await setupDraft();
    c.response.apply = () => {
      throw new AppError("synthetic", { kind: "network", requestId: "req_public_503" });
    };
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent("req_public_503");
    expect(c.api.bodies(applyPath)).toHaveLength(1);
    c.response.apply = () => acknowledgement;
    await c.user.click(c.confirm());
    await screen.findByText("비활성 정책 초안을 생성했습니다.");
    expect(c.api.bodies(applyPath)).toHaveLength(2);
  });
  for (const change of ["principal", "owner", "epoch", "unmount"] as const) {
    it(`${change} 후 이전 성공이 새 dialog/cache를 갱신하지 않는다`, async () => {
      const c = await setupDraft();
      const held = deferred<typeof acknowledgement>();
      c.response.apply = () => held.promise;
      await c.user.click(c.button());
      await c.user.click(c.confirm());
      const gets = c.api.calls.filter(({ key }) => key === "GET /admin/policies").length;
      if (change === "principal") c.update({ principal: "usr_public_b" });
      if (change === "owner") c.update({ owner: "gateway.providers" });
      if (change === "epoch") act(() => tokenStore.clearAll());
      if (change === "unmount") c.view.unmount();
      await act(async () => held.resolve(acknowledgement));
      expect(screen.queryByText("비활성 정책 초안을 생성했습니다.")).not.toBeInTheDocument();
      expect(c.api.calls.filter(({ key }) => key === "GET /admin/policies")).toHaveLength(gets);
    });
  }
  it("A 이전 응답이 이미 진행 중인 새 계정 B의 잠금을 풀지 않는다", async () => {
    const c = await setupDraft();
    const a = deferred<typeof acknowledgement>();
    const b = deferred<typeof acknowledgement>();
    c.response.apply = () => a.promise;
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    c.update({ principal: "usr_public_b" });
    c.response.apply = () => b.promise;
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    await act(async () => a.resolve(acknowledgement));
    expect(within(c.dialog()).getByRole("button", { name: "생성 중" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("비활성 정책 초안을 생성했습니다.")).not.toBeInTheDocument();
    await act(async () => b.resolve(acknowledgement));
    expect(await screen.findByText("비활성 정책 초안을 생성했습니다.")).toBeVisible();
    expect(c.api.bodies(applyPath)).toHaveLength(2);
  });
  it("전송 후 readonly 전환은 이미 확정된 생성 사실을 실패로 바꾸지 않는다", async () => {
    const c = await setupDraft();
    const held = deferred<typeof acknowledgement>();
    c.response.apply = () => held.promise;
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    c.update({ mode: "read_only" });
    await act(async () => held.resolve(acknowledgement));
    expect(await screen.findByText("비활성 정책 초안을 생성했습니다.")).toBeVisible();
    expect(c.api.bodies(applyPath)).toHaveLength(1);
  });
  it("중첩 값의 현재 접두사 표시는 보호하되 실제 payload는 변경하지 않는다", async () => {
    const c = await setupDraft();
    const marker = `prefix_${"public_synthetic_".repeat(3)}`;
    c.response.rows = [
      {
        ...advice,
        title: "마스킹 검토",
        conditions: { custom: { private: marker } },
        actions: { custom: [marker] },
      },
    ];
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
    });
    await screen.findByText("마스킹 검토");
    await c.user.click(c.button());
    c.update({ prefixes: ["prefix_"] });
    expect(c.dialog().outerHTML).not.toContain(marker);
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toEqual([
      {
        title: "마스킹 검토",
        conditions: c.response.rows[0]?.conditions,
        actions: c.response.rows[0]?.actions,
      },
    ]);
    expect(c.view.client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("기간이 바뀌어도 고정된 이전 기간·규칙을 명시 재확인한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const old = c.capture();
    c.changeWindow("30d");
    await waitFor(() => expect(c.confirm()).toBeDisabled());
    expect(c.dialog()).toHaveTextContent("최근 7일");
    await waitFor(() =>
      expect(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" })).toBeEnabled(),
    );
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    await act(async () => old());
    expect(c.api.bodies(applyPath)).toEqual([]);
    await c.user.click(c.confirm());
    expect(c.api.bodies(applyPath)).toEqual([
      { title: advice.title, conditions: advice.conditions, actions: advice.actions },
    ]);
  });
  it("오래된 직접 open/submit은 inner unmount 후 전송하지 않는다", async () => {
    const c = await setupDraft();
    const open = c.capture("open");
    await c.user.click(c.button());
    const submit = c.capture();
    c.view.unmount();
    await act(async () => {
      open();
      submit();
    });
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
});
