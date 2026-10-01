import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import {
  deferred,
  flow,
  list,
  recordedAt,
  renderTrace,
  requestRef,
  rootRef,
  runtime,
} from "./trace-safe-flow-test-harness";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

const retry = () => screen.getByRole("button", { name: "단계 기록 다시 조회" });
const table = () => screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
const namedFlow = (name: string) => ({ ...flow, spans: [{ ...flow.spans[0], name }] });

describe("안전한 Trace 단계 조회", () => {
  it("serverAvailable 유지 중 읽기 권한 회수는 새 목록 GET과 수동 조회도 막는다", async () => {
    const view = renderTrace(undefined, "Asia/Seoul", true);
    await table();
    const before = view.calls.filter((call) => call.path === "/admin/requests").length;
    const captured = view.client
      .getQueryCache()
      .find({ queryKey: ["admin", "requests", "trace-explorer"], exact: false });
    act(() => {
      runtime.scopes = [];
      view.rerenderRuntime();
    });
    await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.");
    expect(view.calls.filter((call) => call.path === "/admin/requests")).toHaveLength(before);
    expect(screen.queryByText("synthetic-request", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "새로고침" })).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(1);
    expect(captured).toBeDefined();
    await expect(captured?.fetch()).rejects.toBeInstanceOf(AppError);
    expect(view.calls.filter((call) => call.path === "/admin/requests")).toHaveLength(before);
    act(() => {
      runtime.scopes = ["admin:read"];
      view.rerenderRuntime();
    });
    await table();
    expect(view.calls.filter((call) => call.path === "/admin/requests")).toHaveLength(before + 1);
  });
  it("목록 GET 대기 중 권한 회수는 늦은 목록을 캐시에 게시하지 않는다", async () => {
    const view = renderTrace(undefined, "Asia/Seoul", true);
    await table();
    const pending = deferred<unknown>();
    view.replyList(() => pending.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    act(() => {
      runtime.scopes = [];
      view.rerenderRuntime();
    });
    await act(async () => {
      pending.resolve({ ...list, requests: [{ ...list.requests[0], model: "late-parent-marker" }] });
      await refresh;
    });
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
  it("기존 읽기 전용 요청 요약과 선택을 유지한다", async () => {
    const view = renderTrace();
    expect(await screen.findByRole("region", { name: "1번째 요청 synthetic-request" })).toBeVisible();
    expect(screen.getByRole("button", { name: "요청 상세 닫기" })).toBeVisible();
    expect(
      view.calls.every((call) => call.path === "/admin/requests" || call.path === "/admin/app/request-flow"),
    ).toBe(true);
  });
  it("선택한 요청의 안전한 단계와 시간 의미를 표시한다", async () => {
    renderTrace();
    expect(await screen.findByRole("region", { name: "선택한 요청의 단계 기록" })).toBeVisible();
    expect(await screen.findByRole("table", { name: "기록된 요청 단계와 시간" })).toBeVisible();
    expect(screen.getByText("기록 상대 위치")).toBeVisible();
  });
  it("readonly에서도 원문 나노초와 opaque ref만 전송하고 새 cache key에 raw ID를 넣지 않는다", async () => {
    const view = renderTrace();
    await table();
    expect(view.flowCalls()).toHaveLength(1);
    expect(view.flowCalls()[0]?.query).toEqual({ request_ref: requestRef, created_at: recordedAt });
    const keys = view.client
      .getQueryCache()
      .findAll()
      .filter((query) => query.queryKey[1] === "app-request-flow")
      .map((query) => query.queryKey);
    expect(JSON.stringify(keys)).not.toContain("synthetic-request");
    expect(JSON.stringify(keys)).toContain(requestRef);
    expect(screen.getByText("0 ms (기록값)")).toBeVisible();
    expect(screen.getByText(/표시할 하위 단계가 없습니다/u)).toBeVisible();
  });
  it("도구 null, skipped, unknown, 음수 위치와 조회 범위를 한글로 구분한다", async () => {
    renderTrace(async () => ({
      ...flow,
      spans: [
        ...flow.spans,
        {
          ...flow.spans[0],
          span_ref: `span_${"t".repeat(43)}`,
          parent_ref: rootRef,
          kind: "tool",
          name: "도구 기록",
          status: "unknown",
          offset_ms: -25,
          duration_ms: null,
        },
        {
          ...flow.spans[0],
          span_ref: `span_${"s".repeat(43)}`,
          parent_ref: rootRef,
          kind: "text2sql",
          name: "SQL 기록",
          status: "skipped",
          recorded_at: null,
          offset_ms: null,
          duration_ms: null,
        },
      ],
      coverage: { ...flow.coverage, tools: { limit: 100, truncated: true, omitted: 20 } },
    }));
    const result = await table();
    expect(within(result).getByText("소요 시간 미기록")).toBeVisible();
    expect(within(result).getByText("건너뜀")).toBeVisible();
    expect(within(result).getByText("-25 ms")).toBeVisible();
    expect(screen.getByText(/표시 생략 20개/u)).toBeVisible();
  });
  it("오류를 자동 재시도하지 않고 요청 ID와 수동 재조회만 제공한다", async () => {
    const view = renderTrace(async () => {
      throw new AppError("raw upstream secret", { kind: "http", status: 503, requestId: "safe-request-1" });
    });
    expect(await screen.findByText("단계 기록을 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByText("요청 ID: safe-request-1")).toBeVisible();
    expect(screen.queryByText("raw upstream secret")).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(1);
    const pending = deferred<unknown>();
    view.reply(() => pending.promise);
    await userEvent.setup().dblClick(retry());
    expect(view.flowCalls()).toHaveLength(2);
    expect(retry()).toHaveAttribute("aria-disabled", "true");
    await act(async () => pending.resolve(flow));
    await table();
  });
  it("404는 지원·범위 확인 안내이며 원시 fallback이나 empty로 바꾸지 않는다", async () => {
    const view = renderTrace(async () => {
      throw new AppError("unavailable", { kind: "http", status: 404 });
    });
    expect(await screen.findByText("이 요청의 단계 기록을 열 수 없습니다.")).toBeVisible();
    expect(screen.queryByText(/표시할 하위 단계가 없습니다/u)).not.toBeInTheDocument();
    expect(
      view.calls.every((call) => ["/admin/requests", "/admin/app/request-flow"].includes(call.path)),
    ).toBe(true);
  });
  it.each([
    { ...flow, private_payload: "not shown" },
    { ...flow, request_ref: `req_${"z".repeat(22)}.${"z".repeat(21)}` },
    { ...flow, created_at: "2026-10-01T01:02:03.123456788Z" },
  ])("strict 또는 현재 대상 불일치 응답을 거부한다 %#", async (reply) => {
    renderTrace(async () => reply);
    expect(await screen.findByText("단계 기록을 불러오지 못했습니다.")).toBeVisible();
    expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
  });
  it("같은 owner 목록 갱신 중 기존 표와 초점을 보존하고 성공 뒤 새 기준으로 확인한다", async () => {
    const view = renderTrace();
    const original = await table();
    retry().focus();
    const pending = deferred<unknown>();
    view.replyList(() => pending.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    expect(await screen.findByText("현재 목록을 확인해야 합니다.")).toBeVisible();
    expect(await table()).toBe(original);
    expect(retry()).toHaveFocus();
    expect(retry()).toHaveAttribute("aria-disabled", "true");
    await userEvent.setup().click(retry());
    expect(view.flowCalls()).toHaveLength(1);
    await act(async () => {
      pending.resolve(list);
      await refresh;
    });
    await waitFor(() => expect(view.flowCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/이전 단계 기록입니다/u)).not.toBeInTheDocument());
    expect(retry()).toHaveFocus();
  });
  it("실패한 목록 LKG는 새 상세를 승인하지 않는다", async () => {
    const view = renderTrace();
    await table();
    view.replyList(async () => {
      throw new AppError("list unavailable", { kind: "http", status: 503 });
    });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    expect(await screen.findByText("현재 목록을 확인해야 합니다.")).toBeVisible();
    await userEvent.setup().click(retry());
    expect(view.flowCalls()).toHaveLength(1);
    expect(screen.getByText(/이전 단계 기록입니다/u)).toBeVisible();
  });
  it.each(["principal", "owner", "scope", "epoch"])(
    "%s 수명 변경 후 늦은 A 응답이 새 수명에 들어오지 않는다",
    async (kind) => {
      const pending = deferred<unknown>();
      const view = renderTrace(() => pending.promise);
      await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
      view.reply(async () => namedFlow("새 수명 기록"));
      act(() => {
        if (kind === "principal") runtime.id = "reader-b";
        if (kind === "owner") runtime.owner = "other";
        if (kind === "scope") runtime.scopes = [];
        if (kind === "epoch") tokenStore.clearAll();
        view.rerenderRuntime();
      });
      if (kind === "owner" || kind === "scope") {
        await screen.findByText("현재 화면의 요청 조회 권한을 확인할 수 없습니다.");
        act(() => {
          runtime.owner = "observability.traces";
          runtime.scopes = ["admin:read"];
          view.rerenderRuntime();
        });
      }
      expect(await screen.findByText("새 수명 기록")).toBeVisible();
      await act(async () => pending.resolve(namedFlow("옛 수명 기록")));
      expect(screen.queryByText("옛 수명 기록")).not.toBeInTheDocument();
      expect(view.flowCalls()[0]?.signal?.aborted).toBe(true);
    },
  );
  it("owner 교체의 미완료 목록에 이전 owner의 placeholder 행을 노출하지 않는다", async () => {
    const view = renderTrace();
    await table();
    const held = deferred<unknown>();
    view.replyList(() => held.promise);
    act(() => {
      runtime.id = "reader-b";
      view.rerenderRuntime();
    });
    expect(screen.queryByText("synthetic-request", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
    await act(async () => held.resolve(list));
    await table();
  });
  it("현재 접두사로 이름과 오류 Request ID를 재표시 보호한다", async () => {
    const marker = `later_${"x".repeat(40)}`;
    const view = renderTrace(async () => namedFlow(marker));
    expect(await screen.findByText(marker)).toBeVisible();
    act(() => {
      runtime.prefixes = ["later_"];
      view.rerenderRuntime();
    });
    expect(view.container.innerHTML).not.toContain(marker);
    view.reply(async () => {
      throw new AppError("unsafe", { kind: "http", status: 503, requestId: marker });
    });
    await userEvent.setup().click(retry());
    expect(await screen.findByText("요청 ID: [값 비공개]")).toBeVisible();
    expect(view.container.innerHTML).not.toContain(marker);
  });
  it("선택 A→B→A에서 예전 A 응답과 cache를 새 A 수명에 재사용하지 않는다", async () => {
    const pending = deferred<unknown>();
    const view = renderTrace(() => pending.promise);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    const refB = `req_${"b".repeat(22)}.${"b".repeat(21)}`;
    view.replyList(async () => ({ ...list, requests: [{ ...list.requests[0], request_ref: refB }] }));
    view.reply(async () => ({ ...namedFlow("B 기록"), request_ref: refB }));
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    expect(await screen.findByText("B 기록")).toBeVisible();
    view.replyList(async () => list);
    view.reply(async () => namedFlow("새 A 기록"));
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    expect(await screen.findByText("새 A 기록")).toBeVisible();
    await act(async () => pending.resolve(namedFlow("옛 A 기록")));
    expect(screen.queryByText("옛 A 기록")).not.toBeInTheDocument();
    expect(view.flowCalls()).toHaveLength(3);
  });
  it("parent 갱신 중 완료된 응답은 게시하지 않고 성공한 새 목록 기준만 사용한다", async () => {
    const pendingFlow = deferred<unknown>();
    const pendingList = deferred<unknown>();
    const view = renderTrace(() => pendingFlow.promise);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    view.replyList(() => pendingList.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.client.refetchQueries({ queryKey: ["admin", "requests", "trace-explorer"] });
    });
    await screen.findByText("현재 목록을 확인해야 합니다.");
    await act(async () => pendingFlow.resolve(namedFlow("오래된 기준 기록")));
    expect(screen.queryByText("오래된 기준 기록")).not.toBeInTheDocument();
    view.reply(async () => namedFlow("새 기준 기록"));
    await act(async () => {
      pendingList.resolve(list);
      await refresh;
    });
    expect(await screen.findByText("새 기준 기록")).toBeVisible();
  });
  it("닫은 선택의 요청과 수명 cache를 폐기한다", async () => {
    const pending = deferred<unknown>();
    const view = renderTrace(() => pending.promise);
    await waitFor(() => expect(view.flowCalls()).toHaveLength(1));
    await userEvent.setup().click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    await act(async () => pending.resolve(namedFlow("닫힌 기록")));
    expect(view.flowCalls()[0]?.signal?.aborted).toBe(true);
    expect(
      view.client
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey[1] === "app-request-flow"),
    ).toHaveLength(0);
    expect(screen.queryByText("닫힌 기록")).not.toBeInTheDocument();
  });
  it("단계 표 스크롤 영역은 실제 Tab으로 접근 가능한 이름 있는 영역이다", async () => {
    const view = renderTrace();
    await table();
    retry().focus();
    await userEvent.setup().tab();
    expect(screen.getByRole("region", { name: "단계 표 가로 스크롤" })).toHaveFocus();
    expect((await axe.run(view.container)).violations).toHaveLength(0);
  });
  it("사용자 A→B→A의 이전 목록 캐시를 새 소유자의 확인된 목록으로 쓰지 않는다", async () => {
    const view = renderTrace();
    await table();
    act(() => {
      runtime.id = "reader-b";
      view.rerenderRuntime();
    });
    await table();
    const pending = deferred<unknown>();
    view.replyList(() => pending.promise);
    act(() => {
      runtime.id = "reader-a";
      view.rerenderRuntime();
    });
    expect(screen.queryByRole("region", { name: "선택한 요청의 단계 기록" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(list));
    await table();
  });
  it.each([
    ["Asia/Seoul", "10:02:03"],
    ["UTC", "1:02:03"],
  ])("%s 표시에도 nano 원문 속성과 전송은 보존한다", async (timeZone, shown) => {
    const view = renderTrace(undefined, timeZone);
    await table();
    const card = screen.getByRole("region", { name: "선택한 요청의 단계 기록" });
    const times = within(card).getAllByTitle(recordedAt);
    expect(times).toHaveLength(2);
    for (const time of times) {
      expect(time).toHaveAttribute("dateTime", recordedAt);
      expect(time).toHaveTextContent(shown);
    }
    expect(view.flowCalls()[0]?.query).toEqual({ request_ref: requestRef, created_at: recordedAt });
  });
});
