import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, forwardRef, type ComponentProps, type MouseEvent } from "react";
import type * as ButtonModule from "@/shared/components/ui/Button";
import type * as TableModule from "./TraceRequestTable";
import { AppError } from "@/shared/api/error";
import { deferred, flow, list, renderTrace, requestRef, rootRef } from "./trace-safe-flow-test-harness";

const observed = vi.hoisted(() => ({
  clicks: new Map<string, () => void>(),
  select: undefined as ComponentProps<typeof TableModule.TraceRequestTable>["onSelect"] | undefined,
  row: undefined as ComponentProps<typeof TableModule.TraceRequestTable>["requests"][number] | undefined,
}));
vi.mock("@/shared/components/ui/Button", async (original) => {
  const actual = await original<typeof ButtonModule>();
  return {
    ...actual,
    Button: forwardRef<HTMLButtonElement, ButtonModule.ButtonProps>(function ObservedButton(props, ref) {
      const label = Children.toArray(props.children)
        .filter((child) => typeof child === "string")
        .join("")
        .trim();
      if (props.onClick) {
        const action = props.onClick;
        observed.clicks.set(label, () => action({} as MouseEvent<HTMLButtonElement>));
      }
      return <actual.Button {...props} ref={ref} />;
    }),
  };
});
vi.mock("./TraceRequestTable", async (original) => {
  const actual = await original<typeof TableModule>();
  return {
    ...actual,
    TraceRequestTable: (props: ComponentProps<typeof actual.TraceRequestTable>) => {
      observed.select = props.onSelect;
      observed.row = props.requests[0];
      return <actual.TraceRequestTable {...props} />;
    },
  };
});
beforeEach(() => {
  observed.clicks.clear();
  observed.select = undefined;
  observed.row = undefined;
});
const denied = (requestId = "public-trace-denied") =>
  new AppError("PRIVATE_DENIAL_BODY", { kind: "permission", status: 403, requestId });
const table = () => screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
function captured(label: string) {
  const action = observed.clicks.get(label);
  if (!action) throw new Error("Missing actual Button callback");
  return action;
}

describe("추적 조회의 서버 거부", () => {
  it.each([401, 403])("retires prior list and dependent flow after list HTTP %s", async (status) => {
    const view = renderTrace(undefined, "Asia/Seoul", true);
    await screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
    const query = view.client
      .getQueryCache()
      .find({ queryKey: ["admin", "requests", "trace-explorer"], exact: false });
    if (!query) throw new Error("Missing actual list Query");
    view.replyList(async () => {
      throw new AppError("PRIVATE_DENIAL_BODY", { kind: status === 401 ? "auth" : "permission", status });
    });
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(query.state.status).toBe("error"));
    const data = view.client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.state.data);
    expect({
      list: screen.queryByRole("button", { name: "1번째 요청 synthetic-request 상세 보기" }) !== null,
      flow: screen.queryByRole("table", { name: "기록된 요청 단계와 시간" }) !== null,
      cachedList: JSON.stringify(data).includes(requestRef),
      cachedFlow: JSON.stringify(data).includes(rootRef),
    }).toEqual({ list: false, flow: false, cachedList: false, cachedFlow: false });
  });

  it.each([401, 403])(
    "retires prior flow after detail HTTP %s while keeping the authorized list",
    async (status) => {
      const view = renderTrace(undefined, "Asia/Seoul", true);
      await screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
      const query = view.client
        .getQueryCache()
        .find({ queryKey: ["admin", "app-request-flow"], exact: false });
      if (!query) throw new Error("Missing actual flow Query");
      view.reply(async () => {
        throw new AppError("PRIVATE_DENIAL_BODY", { kind: status === 401 ? "auth" : "permission", status });
      });
      await userEvent.click(screen.getByRole("button", { name: "단계 기록 다시 조회" }));
      await waitFor(() => expect(query.state.status).toBe("error"));
      const data = view.client
        .getQueryCache()
        .findAll({ queryKey: ["admin", "app-request-flow"] })
        .map((entry) => entry.state.data);
      expect({
        visible: screen.queryByRole("table", { name: "기록된 요청 단계와 시간" }) !== null,
        cached: JSON.stringify(data).includes(rootRef),
      }).toEqual({ visible: false, cached: false });
      expect(screen.getByRole("button", { name: "1번째 요청 synthetic-request 상세 보기" })).toBeVisible();
    },
  );

  it("keeps a denied flow retired through parent refresh until explicit recovery", async () => {
    const view = renderTrace(undefined, "Asia/Seoul", true);
    await table();
    const oldQuery = view.client
      .getQueryCache()
      .find({ queryKey: ["admin", "app-request-flow"], exact: false });
    const queryFn = oldQuery?.options.queryFn;
    if (!oldQuery || typeof queryFn !== "function") throw new Error("Missing flow query function");
    const oldRetry = captured("단계 기록 다시 조회");
    view.reply(async () => {
      throw denied();
    });
    await userEvent.click(screen.getByRole("button", { name: "단계 기록 다시 조회" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveFocus();
    expect(notice).toHaveTextContent("public-trace-denied");
    expect(notice).not.toHaveTextContent("PRIVATE_DENIAL_BODY");
    await act(async () => oldRetry());
    await expect(
      queryFn({
        client: view.client,
        queryKey: oldQuery.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(view.flowCalls()).toHaveLength(2);
    const pendingList = deferred<typeof list>();
    view.replyList(() => pendingList.promise);
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeDisabled();
    await act(async () => pendingList.resolve(list));
    await waitFor(() =>
      expect(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" })).toBeEnabled(),
    );
    expect(view.flowCalls()).toHaveLength(2);
    const pendingFlow = deferred<typeof flow>();
    view.reply(() => pendingFlow.promise);
    await userEvent.click(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
    await act(async () => pendingFlow.resolve(flow));
    await table();
    await act(async () => oldRetry());
    expect(view.flowCalls()).toHaveLength(3);
    expect(view.client.getQueryCache().get(oldQuery.queryHash)).toBeUndefined();
  });

  it("retires list, row and child callbacks across recovery of identical records", async () => {
    const view = renderTrace(undefined, "Asia/Seoul", true);
    await table();
    const oldQuery = view.client
      .getQueryCache()
      .find({ queryKey: ["admin", "requests", "trace-explorer"], exact: false });
    const queryFn = oldQuery?.options.queryFn;
    const oldSelect = observed.select;
    const oldRow = observed.row;
    const oldRefresh = captured("새로고침");
    const oldFlowRetry = captured("단계 기록 다시 조회");
    const trigger = screen.getByRole("button", { name: "1번째 요청 synthetic-request 상세 보기" });
    if (
      !oldQuery ||
      typeof queryFn !== "function" ||
      !oldSelect ||
      !oldRow ||
      !(trigger instanceof HTMLButtonElement)
    )
      throw new Error("Missing live list callbacks");
    view.replyList(async () => {
      throw denied();
    });
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveFocus();
    const attempts = view.calls.length;
    await act(async () => {
      oldRefresh();
      oldFlowRetry();
      oldSelect(oldRow, trigger);
    });
    await expect(
      queryFn({
        client: view.client,
        queryKey: oldQuery.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(view.calls).toHaveLength(attempts);
    const pending = deferred<typeof list>();
    view.replyList(() => pending.promise);
    await userEvent.click(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await waitFor(() => expect(view.calls).toHaveLength(attempts + 1));
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(list));
    await table();
    const freshAttempts = view.calls.length;
    await act(async () => {
      oldRefresh();
      oldFlowRetry();
      oldSelect(oldRow, trigger);
    });
    expect(view.calls).toHaveLength(freshAttempts);
    expect(view.client.getQueryCache().get(oldQuery.queryHash)).toBeUndefined();
  });

  it.each(["corp_" + "x".repeat(32), "bad/id", "x".repeat(129)])(
    "hides unsafe flow diagnostic %s",
    async (requestId) => {
      const view = renderTrace(undefined, "Asia/Seoul", true);
      await table();
      view.reply(async () => {
        throw denied(requestId);
      });
      await userEvent.click(screen.getByRole("button", { name: "단계 기록 다시 조회" }));
      const notice = await screen.findByRole("alert");
      expect(notice).not.toHaveTextContent(requestId);
      expect(notice).not.toHaveTextContent("PRIVATE_DENIAL_BODY");
    },
  );
});
