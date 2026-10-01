import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ButtonModule from "@/shared/components/ui/Button";
import type * as TableModule from "./TraceRequestTable";
import { traceSafeFlowSchema } from "@/shared/api/domains/trace-safe-flow.schema";
import { deferred, flow, list, renderTrace, row, runtime } from "./trace-safe-flow-test-harness";

const observed = vi.hoisted(() => ({
  clicks: new Map<string, () => void>(),
  select: undefined as ComponentProps<typeof TableModule.TraceRequestTable>["onSelect"] | undefined,
  request: undefined as ComponentProps<typeof TableModule.TraceRequestTable>["requests"][number] | undefined,
  search: "",
}));

// Observe real rendered callbacks without replacing the Button, table, Router,
// Query or their event behavior. Captured invocation deliberately models the gap
// before React commits its cache notification; it is not a physical disabled click.
vi.mock("@/shared/components/ui/Button", async (importOriginal) => {
  const actual = await importOriginal<typeof ButtonModule>();
  return {
    ...actual,
    Button: function ObservedButton(props: ComponentProps<typeof actual.Button>) {
      const label = props["aria-label"] ?? (typeof props.children === "string" ? props.children : undefined);
      if (label && props.onClick) {
        const callback = props.onClick;
        observed.clicks.set(label, () => Reflect.apply(callback, undefined, []));
      }
      return <actual.Button {...props} />;
    },
  };
});

vi.mock("./TraceRequestTable", async (importOriginal) => {
  const actual = await importOriginal<typeof TableModule>();
  const { useLocation } = await import("react-router");
  return {
    ...actual,
    TraceRequestTable: function ObservedTable(props: ComponentProps<typeof actual.TraceRequestTable>) {
      observed.select = props.onSelect;
      observed.request = props.requests[0];
      observed.search = useLocation().search;
      return <actual.TraceRequestTable {...props} />;
    },
  };
});

const table = () => screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
const retry = () => screen.getByRole("button", { name: "단계 기록 다시 조회" });
const rowButton = () => {
  const button = screen.getByRole("button", { name: "1번째 요청 synthetic-request 상세 보기" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a real row button");
  return button;
};
const parentQuery = (view: ReturnType<typeof renderTrace>) => {
  const parent = view.client.getQueryCache().find({
    queryKey: ["admin", "requests", "trace-explorer"],
    exact: false,
    predicate: (query) => query.getObserversCount() > 0,
  });
  if (!parent) throw new Error("Expected the actual parent Query");
  return parent;
};
const capturedRetry = () => {
  const callback = observed.clicks.get("단계 기록 다시 조회");
  if (!callback) throw new Error("Expected the real rendered retry callback");
  return callback;
};
const capturedSelection = () => {
  if (!observed.select) throw new Error("Expected the real rendered row callback");
  return observed.select;
};
const capturedRow = () => {
  if (!observed.request) throw new Error("Expected the actual rendered row");
  return observed.request;
};

beforeEach(() => {
  observed.clicks.clear();
  observed.select = undefined;
  observed.request = undefined;
  observed.search = "";
});
afterEach(() => vi.restoreAllMocks());

describe("추적 목록의 현재 조회와 상세 선택 경계", () => {
  it("현재 부모의 캡처 Query.fetch와 실제 재조회 버튼은 단계 GET을 허용한다", async () => {
    const view = renderTrace();
    await table();
    const child = view.client.getQueryCache().find({ queryKey: ["admin", "app-request-flow"], exact: false });
    expect(child).toBeDefined();
    expect(view.flowCalls()).toHaveLength(1);
    await act(async () => {
      await child?.fetch();
    });
    expect(view.flowCalls()).toHaveLength(2);
    await userEvent.setup().click(retry());
    await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
    await table();
  });

  it.each(["invalidate", "fetching"] as const)(
    "부모 %s 직후 React commit 전의 캡처 재조회는 단계 GET을 보내지 않는다",
    async (change) => {
      const view = renderTrace();
      await table();
      const parent = parentQuery(view);
      const oldRetry = capturedRetry();
      const held = deferred<unknown>();
      view.replyList(() => held.promise);
      let pending: Promise<unknown> | undefined;
      let atAdmission = -1;
      act(() => {
        if (change === "invalidate") parent.invalidate();
        else {
          pending = parent.fetch();
          expect(parent.state.fetchStatus).toBe("fetching");
        }
        oldRetry();
        atAdmission = view.flowCalls().length;
      });
      try {
        expect(atAdmission).toBe(1);
      } finally {
        await act(async () => {
          held.resolve(list);
          await pending;
        });
      }
    },
  );

  it("목록 무효화 직후 React commit 전 옛 행 선택은 URL과 새 상세를 바꾸지 않는다", async () => {
    const view = renderTrace();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
    const parent = parentQuery(view);
    const choose = capturedSelection();
    const renderedRow = capturedRow();
    const trigger = rowButton();
    act(() => choose(renderedRow, trigger));
    expect(new URLSearchParams(observed.search).get("selected_request")).toBe(row.request_id);
    await table();
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    const currentChoose = capturedSelection();
    const currentRow = capturedRow();
    const currentTrigger = rowButton();
    const flowCount = view.flowCalls().length;
    const before = observed.search;
    expect(new URLSearchParams(before).has("selected_request")).toBe(false);
    act(() => {
      parent.invalidate();
      currentChoose(currentRow, currentTrigger);
    });
    expect(observed.search).toBe(before);
    expect(view.flowCalls()).toHaveLength(flowCount);
    expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
  });

  it("동일 Date.now와 동일 응답 객체여도 새 목록 성공은 기존 단계의 재확인을 요구한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const view = renderTrace();
    await table();
    const parent = parentQuery(view);
    const beforeData = parent.state.data;
    const beforeTimestamp = parent.state.dataUpdatedAt;
    const beforeCount = parent.state.dataUpdateCount;
    view.replyList(async () => list);
    await act(async () => {
      await parent.fetch();
    });
    expect(parent.state.dataUpdatedAt).toBe(beforeTimestamp);
    expect(parent.state.data).toBe(beforeData);
    expect(parent.state.dataUpdateCount).toBe(beforeCount + 1);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(2));
    expect(await table()).toBeVisible();
  });

  it.each(["invalidate", "fetching"] as const)(
    "부모 %s 직후 실제 자식 Query.fetch도 React commit 전 외부 GET을 차단한다",
    async (change) => {
      const view = renderTrace();
      await table();
      const parent = parentQuery(view);
      const child = view.client.getQueryCache().find({
        queryKey: ["admin", "app-request-flow"],
        exact: false,
      });
      if (!child) throw new Error("Expected the actual child Query");
      const held = deferred<unknown>();
      view.replyList(() => held.promise);
      let parentPending: Promise<unknown> | undefined;
      let childPending: Promise<unknown> | undefined;
      let atAdmission = -1;
      act(() => {
        if (change === "invalidate") parent.invalidate();
        else parentPending = parent.fetch();
        childPending = child.fetch().catch(() => undefined);
        atAdmission = view.flowCalls().length;
      });
      try {
        expect(atAdmission).toBe(1);
      } finally {
        await act(async () => {
          held.resolve(list);
          await Promise.all([parentPending, childPending]);
        });
      }
    },
  );

  it.each(["held", "failed"] as const)(
    "목록 %s 중에는 새 상세 선택을 막고 현재 성공 뒤 같은 실제 행을 허용한다",
    async (state) => {
      const view = renderTrace();
      const user = userEvent.setup();
      await table();
      await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
      const parent = parentQuery(view);
      const held = deferred<unknown>();
      view.replyList(() => held.promise);
      let pending: Promise<unknown> | undefined;
      act(() => {
        pending = parent.fetch().catch(() => undefined);
      });
      if (state === "failed") {
        await act(async () => {
          held.reject(new Error("Synthetic list failure"));
          await pending;
        });
        expect(parent.state.status).toBe("error");
      } else expect(parent.state.fetchStatus).toBe("fetching");
      const before = observed.search;
      const choose = capturedSelection();
      const request = capturedRow();
      const trigger = rowButton();
      try {
        act(() => choose(request, trigger));
        expect(observed.search).toBe(before);
        expect(view.flowCalls()).toHaveLength(1);
        expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
      } finally {
        await act(async () => {
          if (state === "held") {
            held.resolve(list);
            await pending;
          } else {
            view.replyList(async () => list);
            await parent.fetch();
          }
        });
      }
      expect(parent.state.status).toBe("success");
      act(() => capturedSelection()(capturedRow(), rowButton()));
      await table();
      expect(view.flowCalls()).toHaveLength(2);
      expect(new URLSearchParams(observed.search).get("selected_request")).toBe(row.request_id);
    },
  );

  it("화면 소유자 A→B→A 뒤 옛 행 선택은 되살아나지 않고 새 선택만 허용한다", async () => {
    const view = renderTrace();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    const oldChoose = capturedSelection();
    const oldRow = capturedRow();
    const oldTrigger = rowButton();
    runtime.owner = "observability.requests";
    view.rerenderRuntime();
    expect(
      screen.getByRole("heading", { name: "현재 화면의 요청 조회 권한을 확인할 수 없습니다." }),
    ).toBeVisible();
    runtime.owner = "observability.traces";
    view.rerenderRuntime();
    await screen.findByRole("button", { name: "1번째 요청 synthetic-request 상세 보기" });
    await waitFor(() => expect(parentQuery(view).state.status).toBe("success"));
    const before = observed.search;
    act(() => oldChoose(oldRow, oldTrigger));
    expect(observed.search).toBe(before);
    expect(view.flowCalls()).toHaveLength(1);
    act(() => capturedSelection()(capturedRow(), rowButton()));
    await table();
    expect(view.flowCalls()).toHaveLength(2);
  });

  it("필터 A→B→A 뒤 옛 행 선택은 되살아나지 않고 현재 결과의 선택만 허용한다", async () => {
    const view = renderTrace();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    const oldChoose = capturedSelection();
    const oldRow = capturedRow();
    const oldTrigger = rowButton();
    await user.type(screen.getByRole("textbox", { name: "모델" }), "candidate-model");
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    await waitFor(() => expect(new URLSearchParams(observed.search).get("model")).toBe("candidate-model"));
    await waitFor(() => expect(parentQuery(view).state.status).toBe("success"));
    await user.click(screen.getByRole("button", { name: "필터 초기화" }));
    await waitFor(() => expect(new URLSearchParams(observed.search).has("model")).toBe(false));
    await waitFor(() => expect(parentQuery(view).state.status).toBe("success"));
    const before = observed.search;
    act(() => oldChoose(oldRow, oldTrigger));
    expect(observed.search).toBe(before);
    expect(view.flowCalls()).toHaveLength(1);
    act(() => capturedSelection()(capturedRow(), rowButton()));
    await table();
    expect(view.flowCalls()).toHaveLength(2);
  });

  it("상세 닫힘과 같은 행 재개방 뒤 옛 재조회는 폐기하고 새 재조회는 허용한다", async () => {
    const view = renderTrace();
    const user = userEvent.setup();
    await table();
    const oldRetry = capturedRetry();
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    act(() => oldRetry());
    expect(view.flowCalls()).toHaveLength(1);
    act(() => capturedSelection()(capturedRow(), rowButton()));
    await table();
    expect(view.flowCalls()).toHaveLength(2);
    act(() => oldRetry());
    expect(view.flowCalls()).toHaveLength(2);
    await user.click(retry());
    await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
  });

  it("부모 무효화 뒤 도착한 유효한 단계 응답은 캐시·화면에 정착하지 않고 현재 재확인은 허용한다", async () => {
    const view = renderTrace();
    await table();
    const parent = parentQuery(view);
    const child = view.client.getQueryCache().find({ queryKey: ["admin", "app-request-flow"], exact: false });
    if (!child) throw new Error("Expected the actual child Query");
    const beforeData = child.state.data;
    const beforeCount = child.state.dataUpdateCount;
    const lateName = "무효화 뒤 늦은 합성 기록";
    const currentName = "재확인된 현재 합성 기록";
    const namedFlow = (name: string) => ({
      ...flow,
      spans: flow.spans.map((span) => ({ ...span, name })),
    });
    const late = traceSafeFlowSchema.parse(namedFlow(lateName));
    const held = deferred<unknown>();
    view.reply(() => held.promise);
    const wronglyAccepted: string[] = [];
    const unsubscribe = view.client.getQueryCache().subscribe((event) => {
      if (event.query === child && JSON.stringify(event.query.state.data)?.includes(lateName))
        wronglyAccepted.push(event.type);
    });
    let pending: Promise<unknown> | undefined;
    try {
      act(() => {
        pending = child.fetch().catch(() => undefined);
      });
      expect(view.flowCalls()).toHaveLength(2);
      expect(child.state.fetchStatus).toBe("fetching");
      await act(async () => {
        parent.invalidate();
        held.resolve(late);
        await pending;
      });
      expect(child.state.data).toBe(beforeData);
      expect(child.state.dataUpdateCount).toBe(beforeCount);
      expect(wronglyAccepted).toEqual([]);
      expect(screen.queryByText(lateName)).not.toBeInTheDocument();
      expect(
        JSON.stringify(
          view.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data),
        ),
      ).not.toContain(lateName);
      view.reply(async () => namedFlow(currentName));
      await act(async () => {
        await parent.fetch();
      });
      await screen.findByRole("rowheader", { name: `${currentName} 요청` });
      expect(view.flowCalls()).toHaveLength(3);
      expect(JSON.stringify(child.state.data)).toContain(currentName);
      expect(wronglyAccepted).toEqual([]);
    } finally {
      held.resolve(late);
      await pending;
      unsubscribe();
    }
  });

  it("같은 시각·같은 frame의 실제 setData 성공 직후 옛 재조회는 막고 새 세대의 조회는 허용한다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const view = renderTrace();
    await table();
    const parent = parentQuery(view);
    const beforeData = parent.state.data;
    const beforeTimestamp = parent.state.dataUpdatedAt;
    const beforeCount = parent.state.dataUpdateCount;
    if (!beforeData) throw new Error("Expected an actual successful parent frame");
    const oldRetry = capturedRetry();
    let atAdmission = -1;
    act(() => {
      parent.setData(beforeData);
      expect(parent.state.data).toBe(beforeData);
      expect(parent.state.dataUpdatedAt).toBe(beforeTimestamp);
      expect(parent.state.dataUpdateCount).toBe(beforeCount + 1);
      oldRetry();
      atAdmission = view.flowCalls().length;
    });
    expect(atAdmission).toBe(1);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(2));
    await waitFor(() => expect(retry()).toHaveAttribute("aria-busy", "false"));
    act(() => oldRetry());
    expect(view.flowCalls()).toHaveLength(2);
    await userEvent.setup().click(retry());
    await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
    expect(await table()).toBeVisible();
  });

  it("캡처 닫기 직후 React commit 전 옛 재조회는 보내지 않고 다시 연 현재 상세는 허용한다", async () => {
    const view = renderTrace();
    await table();
    const oldRetry = capturedRetry();
    const close = observed.clicks.get("요청 상세 닫기");
    if (!close) throw new Error("Expected the real rendered close callback");
    let atAdmission = -1;
    act(() => {
      close();
      oldRetry();
      atAdmission = view.flowCalls().length;
    });
    expect(atAdmission).toBe(1);
    expect(new URLSearchParams(observed.search).has("selected_request")).toBe(false);
    expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
    act(() => capturedSelection()(capturedRow(), rowButton()));
    await table();
    expect(view.flowCalls()).toHaveLength(2);
    await userEvent.setup().click(retry());
    await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
  });
});
