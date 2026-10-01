import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import {
  capturedClicks,
  deferred,
  flow,
  list,
  row,
  recordedAt,
  renderRequests,
  requestRef,
  runtime,
} from "./request-safe-flow-test-harness";

const table = () => screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
async function open(arm = true) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" }));
  await screen.findByRole("dialog");
  if (arm) await user.click(screen.getByRole("button", { name: "처리 단계 보기" }));
  return user;
}

describe("요청 상세의 명시적 단계 조회", () => {
  it("읽기 전용 요청 목록과 기존 상세만 열면 단계 API를 호출하지 않는다", async () => {
    const view = renderRequests();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("프롬프트, 응답 본문, 원시 오류");
    expect(view.listCalls()).toHaveLength(1);
    expect(view.flowCalls()).toHaveLength(0);
  });

  it("명시적으로 처리 단계를 열면 requests 소유권으로 원래 나노초를 전송한다", async () => {
    const view = renderRequests();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" }));
    await user.click(screen.getByRole("button", { name: "처리 단계 보기" }));
    expect(await screen.findByRole("table", { name: "기록된 요청 단계와 시간" })).toBeVisible();
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    expect(view.flowCalls()[0]).toMatchObject({
      routeId: "observability.requests",
      query: { request_ref: requestRef, created_at: recordedAt },
    });
  });

  it("명시 Enter 실행은 현재 단계 결과로 초점을 안내하고 다음 Tab은 재조회에 도달한다", async () => {
    const view = renderRequests();
    const user = await open(false);
    const start = screen.getByRole("button", { name: "처리 단계 보기" });
    start.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("group", { name: "단계 기록 조회 결과" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "단계 기록 다시 조회" })).toHaveFocus();
    expect(view.flowCalls()).toHaveLength(1);
  });

  it("현재 부모와 선택의 캡처된 Query.fetch는 정상적으로 단계 GET을 수행한다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const parent = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
    const child = view.client.getQueryCache().find({ queryKey: ["admin", "app-request-flow"], exact: false });
    expect(parent?.options.queryFn).toBeTypeOf("function");
    expect(child?.options.queryFn).toBeTypeOf("function");
    await act(async () => {
      await child?.fetch();
    });
    expect(view.flowCalls()).toHaveLength(2);
    await act(async () => {
      await parent?.fetch();
    });
    expect(view.listCalls()).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each(["authenticated", "legacy", "open"] as const)(
    "확인된 %s 읽기 사용자와 readonly에서도 명시 조회한다",
    async (mode) => {
      const view = renderRequests({ auth: { mode } });
      await open();
      await table();
      expect(view.flowCalls()).toHaveLength(1);
    },
  );

  it.each([{ userPresent: false }, { scopes: [] }, { mode: "loading" as const }])(
    "모드만으로 사용자/권한을 추정하지 않는다: %j",
    async (auth) => {
      const view = renderRequests({ auth });
      expect(await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.")).toBeVisible();
      expect(view.calls).toHaveLength(0);
    },
  );

  it.each(["observability.traces", "other.feature"])(
    "요청 페이지는 다른 기능 소유자 %s를 승인하지 않는다",
    async (owner) => {
      const view = renderRequests({ actualRoute: false, auth: { owner } });
      expect(await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.")).toBeVisible();
      expect(view.calls).toHaveLength(0);
    },
  );

  it("동일 Date.now와 구조 공유 응답이어도 새 성공 세대는 선택과 명시 승인을 폐기한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const view = renderRequests();
    await open();
    await table();
    const oldQuery = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
    expect(oldQuery).toBeDefined();
    const before = oldQuery?.state.dataUpdatedAt;
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(oldQuery?.state.dataUpdatedAt).toBe(before);
    expect(view.listCalls()).toHaveLength(2);
    await open(false);
    expect(screen.getByRole("button", { name: "처리 단계 보기" })).toBeVisible();
    expect(view.flowCalls()).toHaveLength(1);
  });

  it("부모 갱신 중 기존 단계와 초점은 유지하지만 재조회는 막고 성공 후 닫는다", async () => {
    const view = renderRequests();
    const user = await open();
    await table();
    const button = screen.getByRole("button", { name: "단계 기록 다시 조회" });
    button.focus();
    const held = deferred<unknown>();
    view.replyList(() => held.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.refresh();
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    expect(button).toHaveFocus();
    expect(await table()).toBeVisible();
    await user.click(button);
    expect(view.flowCalls()).toHaveLength(1);
    await act(async () => {
      held.resolve(structuredClone(list));
      await refresh;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" })).toHaveFocus(),
    );
  });

  it("부모 갱신 실패는 이전 DOM을 유지하되 단계 새 조회를 허용하지 않는다", async () => {
    const view = renderRequests();
    const user = await open();
    await table();
    view.replyList(async () => {
      throw new AppError("합성 실패", { kind: "http", status: 503 });
    });
    await act(async () => {
      await view.refresh();
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    expect(await table()).toBeVisible();
    await user.click(screen.getByRole("button", { name: "단계 기록 다시 조회" }));
    expect(view.flowCalls()).toHaveLength(1);
  });

  it("필터 A→B→A의 옛 선택/쿼리는 다시 살아나지 않는다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const oldQuery = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
    expect(oldQuery).toBeDefined();
    act(() => view.navigate("?status=error"));
    await waitFor(() => expect(view.listCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => view.navigate(""));
    await waitFor(() => expect(view.listCalls()).toHaveLength(3));
    await act(async () => {
      await oldQuery?.fetch().catch(() => undefined);
    });
    expect(view.listCalls()).toHaveLength(3);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(1);
  });

  it.each(["id", "team", "mode", "scopes"] as const)(
    "%s 회수/변경 후 복귀해도 옛 목록·단계 수명은 영구 폐기한다",
    async (field) => {
      const held = deferred<unknown>();
      const view = renderRequests();
      view.replyFlow(() => held.promise);
      await open();
      await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
      const oldQuery = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
      expect(oldQuery).toBeDefined();
      const prior = runtime[field];
      act(() => {
        if (field === "id") runtime.id = "reader-b";
        if (field === "team") runtime.team = "team-b";
        if (field === "mode") runtime.mode = "legacy";
        if (field === "scopes") runtime.scopes = [];
        view.rerenderRuntime();
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      act(() => {
        Object.assign(runtime, { [field]: prior });
        view.rerenderRuntime();
      });
      await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" });
      const count = view.listCalls().length;
      await act(async () => {
        held.resolve(flow);
        await oldQuery?.fetch().catch(() => undefined);
      });
      expect(view.listCalls()).toHaveLength(count);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(view.flowCalls()).toHaveLength(1);
      expect(view.client.getQueryCache().findAll({ queryKey: ["admin", "app-request-flow"] })).toHaveLength(
        0,
      );
    },
  );

  it("세션 epoch 교체는 진행 중 단계를 취소하고 새 사용자 조회를 명시적으로 요구한다", async () => {
    const held = deferred<unknown>();
    const view = renderRequests();
    view.replyFlow(() => held.promise);
    await open();
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => held.resolve(flow));
    expect(view.flowCalls()[0]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
  });

  it("닫힌 A의 늦은 응답은 다시 연 B의 단계에 게시되지 않는다", async () => {
    const held = deferred<unknown>();
    const view = renderRequests();
    view.replyFlow(() => held.promise);
    const user = await open();
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "닫기" }));
    view.replyFlow(async () => ({ ...flow, spans: [{ ...flow.spans[0], name: "새 단계" }] }));
    await open();
    await screen.findByText("새 단계");
    await act(async () => held.resolve({ ...flow, spans: [{ ...flow.spans[0], name: "옛 단계" }] }));
    expect(screen.queryByText("옛 단계")).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(2);
  });

  it("선택 행이 새 응답에서 사라지면 결과 제목으로 초점을 돌린다", async () => {
    const view = renderRequests();
    await open();
    await table();
    view.replyList(async () => ({ ...list, requests: [] }));
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { name: "요청 조회 결과" })).toHaveFocus());
  });

  it("같은 비공개 표시와 ref라도 다른 기록 시각의 행으로 초점을 옮기지 않는다", async () => {
    const view = renderRequests();
    await open();
    await table();
    view.replyList(async () => ({
      ...list,
      requests: [{ ...row, created_at: "2026-10-01T01:02:03.123456790Z" }],
    }));
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "요청 조회 결과" })).toHaveFocus());
    expect(view.flowCalls()).toHaveLength(1);
  });

  it.each([404, 500, 503])(
    "HTTP %s는 원시 상세 대신 안전한 오류와 명시 재시도만 제공한다",
    async (status) => {
      const view = renderRequests();
      view.replyFlow(async () => {
        throw new AppError("raw-secret-response", { kind: "http", status, requestId: "safe-request-id" });
      });
      const user = await open();
      await screen.findByText("요청 ID: safe-request-id");
      expect(screen.queryByText("raw-secret-response")).not.toBeInTheDocument();
      expect(view.flowCalls()).toHaveLength(1);
      view.replyFlow(async () => flow);
      await user.click(screen.getByRole("button", { name: "단계 기록 다시 조회" }));
      await table();
      expect(view.flowCalls()).toHaveLength(2);
      expect(
        view.calls.every((call) => ["/admin/requests", "/admin/app/request-flow"].includes(call.path)),
      ).toBe(true);
    },
  );

  it("나노초 원문이 아닌 목록은 추정하거나 보정하여 요청하지 않는다", async () => {
    const view = renderRequests({
      initialList: async () => ({ ...list, requests: [{ ...row, created_at: "2026-10-01T01:02:03Z" }] }),
    });
    await open(false);
    expect(screen.queryByRole("button", { name: "처리 단계 보기" })).not.toBeInTheDocument();
    expect(screen.getByText(/이 목록 응답에서는 처리 단계 조회를 지원하지 않습니다/u)).toBeVisible();
    expect(view.flowCalls()).toHaveLength(0);
  });

  it("동일 목록 세대의 다른 행으로 바뀌어도 명시 승인을 새로 요구한다", async () => {
    const second = { ...row, request_ref: `req_${"c".repeat(22)}.${"d".repeat(21)}` };
    const view = renderRequests({ initialList: async () => ({ ...list, requests: [row, second] }) });
    const user = await open(false);
    const oldStart = capturedClicks.get("처리 단계 보기");
    await user.click(screen.getByRole("button", { name: "처리 단계 보기" }));
    await table();
    // This deliberately calls the real rendered callback, not an inert-modal physical click.
    act(() => capturedClicks.get("2번째 요청 [값 비공개] 상세 보기")?.());
    expect(screen.getByRole("button", { name: "처리 단계 보기" })).toBeVisible();
    act(() => oldStart?.());
    expect(view.flowCalls()).toHaveLength(1);
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
  });

  it.each(["invalidate", "new-success"] as const)(
    "부모 캐시 %s 직후 React 알림 전의 옛 단계 fetch도 요청하지 않는다",
    async (change) => {
      const view = renderRequests();
      await open();
      await table();
      const parent = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
      const child = view.client
        .getQueryCache()
        .find({ queryKey: ["admin", "app-request-flow"], exact: false });
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      await act(async () => {
        if (change === "invalidate") parent?.invalidate();
        else parent?.setData({ response: { ...list, request_contract_version: 2 }, generation: 900 });
        await child?.fetch().catch(() => undefined);
      });
      expect(view.flowCalls()).toHaveLength(1);
    },
  );

  it("닫기 callback 직후 commit 전 옛 단계 fetch도 동기 폐기로 차단한다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const child = view.client.getQueryCache().find({ queryKey: ["admin", "app-request-flow"], exact: false });
    const close = capturedClicks.get("닫기");
    expect(child).toBeDefined();
    expect(close).toBeDefined();
    await act(async () => {
      close?.();
      await child?.fetch().catch(() => undefined);
    });
    expect(view.flowCalls()).toHaveLength(1);
  });

  it("닫기와 같은 행 다시 열기가 한 batch여도 이전 명시 승인을 재사용하지 않는다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const close = capturedClicks.get("닫기");
    const reopen = capturedClicks.get("1번째 요청 [값 비공개] 상세 보기");
    expect(close).toBeDefined();
    expect(reopen).toBeDefined();
    act(() => {
      close?.();
      reopen?.();
    });
    expect(screen.getByRole("button", { name: "처리 단계 보기" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(1);
  });

  it("승인되지 않은 다른 행 callback은 기존 선택의 복귀 초점도 바꾸지 않는다", async () => {
    const second = { ...row, request_ref: `req_${"c".repeat(22)}.${"d".repeat(21)}` };
    const view = renderRequests({ initialList: async () => ({ ...list, requests: [row, second] }) });
    const user = await open();
    await table();
    const held = deferred<unknown>();
    view.replyList(() => held.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.refresh();
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    act(() => capturedClicks.get("2번째 요청 [값 비공개] 상세 보기")?.());
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" })).toHaveFocus(),
    );
    await act(async () => {
      held.resolve(list);
      await refresh;
    });
  });

  it("serverAvailable인 채 읽기 회수하면 목록 GET/옛 수동 callback을 차단하고 늦은 목록을 버린다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const held = deferred<unknown>();
    view.replyList(() => held.promise);
    const captured = view.client.getQueryCache().find({ queryKey: ["admin", "requests"], exact: false });
    expect(captured).toBeDefined();
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.refresh();
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    const before = view.listCalls().length;
    act(() => {
      runtime.scopes = [];
      view.rerenderRuntime();
    });
    await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.");
    await act(async () => {
      held.resolve({ ...list, requests: [{ ...row, model: "late-parent-marker" }] });
      await refresh;
      await captured?.fetch().catch(() => undefined);
    });
    expect(view.listCalls()).toHaveLength(before);
    expect(view.container.innerHTML).not.toContain("late-parent-marker");
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("late-parent-marker");
  });

  it("선택 행이 새 순번으로 이동하면 현재 동일 ref/시각 버튼으로 돌아간다", async () => {
    const view = renderRequests();
    await open();
    await table();
    view.replyList(async () => ({
      ...list,
      requests: [{ ...row, request_ref: `req_${"c".repeat(22)}.${"d".repeat(21)}` }, row],
    }));
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "2번째 요청 [값 비공개] 상세 보기" })).toHaveFocus(),
    );
  });

  it("v2→v1→v2 성공 응답은 이전 승인 없이 단계 조회를 다시 시작하지 않는다", async () => {
    const view = renderRequests();
    await open();
    await table();
    const legacyRow = Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !["request_ref", "request_filterable", "trace_filterable"].includes(key),
      ),
    );
    view.replyList(async () => ({ ...list, requests: [legacyRow] }));
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(false);
    expect(screen.queryByRole("button", { name: "처리 단계 보기" })).not.toBeInTheDocument();
    view.replyList(async () => list);
    await act(async () => {
      await view.refresh();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(false);
    expect(screen.getByRole("button", { name: "처리 단계 보기" })).toBeVisible();
    expect(view.flowCalls()).toHaveLength(1);
  });
});
