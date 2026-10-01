import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/api/error";
import { deferred, list, renderSessions, table } from "./session-list-test-harness";

const openName = "sess-alpha 세션 비행기록 열기";
const ready = () => screen.findByRole("button", { name: openName });
const response = (days: number) => ({
  ...list(days),
  sessions: list(days).sessions.map((item) => ({
    ...item,
    requests: days,
    last_message: `합성 ${days}일 응답`,
  })),
});
const failure = () =>
  new AppError("합성 목록 실패", {
    kind: "http",
    status: 503,
    requestId: "req_independent_sessions",
  });

describe("세션 목록 독립 인수 경계", () => {
  it("캐시된 30일의 최종 갱신 실패는 다른 7일 대신 30일 표와 합계를 유지한다", async () => {
    const user = userEvent.setup();
    const view = renderSessions({ route: "?days=30", initialList: async (days) => response(days) });
    await ready();
    const cachedThirty = view.query();
    expect(cachedThirty?.options.queryFn).toBeTypeOf("function");
    if (!cachedThirty) throw new Error("Missing actual cached 30-day query");
    await act(async () => view.navigate("?days=7"));
    expect(await screen.findByText("합성 7일 응답")).toBeVisible();
    expect(view.lists()).toHaveLength(2);

    const pending = deferred<unknown>();
    view.reply(() => pending.promise);
    // Invalidate the actual inactive 30-day query, without issuing another GET.
    await act(async () => cachedThirty.invalidate());
    await act(async () => view.navigate("?days=30"));
    await waitFor(() => expect(view.query()?.state.fetchStatus).toBe("fetching"));
    expect(view.query()).toBe(cachedThirty);
    expect(view.lists()).toHaveLength(3);
    expect(view.lists()[2]?.query).toEqual({ days: 30 });
    await act(async () => pending.reject(failure()));
    await waitFor(() => expect(view.query()?.state.status).toBe("error"));
    expect(await screen.findByText("최근 30일 조회 실패 · 아래 표와 합계는 이전 30일 결과")).toBeVisible();
    expect(screen.getByText("합성 30일 응답")).toBeVisible();
    expect(screen.queryByText("합성 7일 응답")).not.toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "세션 요약" });
    const requests = within(summary).getByText("요청").closest("article");
    expect(requests).not.toBeNull();
    if (!requests) throw new Error("Missing request summary article");
    expect(within(requests).getByText("30", { selector: "strong" })).toBeVisible();
    await user.click(await ready());
    expect(view.details()).toHaveLength(0);
    expect(view.search()).toBe("?days=30");

    view.reply(async (days) => response(days));
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(view.query()?.state.status).toBe("success"));
    await waitFor(() => expect(view.query()?.state.fetchStatus).toBe("idle"));
    await user.click(await ready());
    await waitFor(() => expect(view.details()).toHaveLength(1));
  });

  it("같은 숫자와 검색으로 해석되는 raw URL 왕복도 옛 행 콜백을 되살리지 않는다", async () => {
    const user = userEvent.setup();
    const rawA = "?days=07&q=%20alpha%20";
    const view = renderSessions({ route: rawA });
    await ready();
    const originalQuery = view.query();
    const oldOpen = table.open;
    const oldRow = table.rows[0];
    expect(originalQuery?.options.queryFn).toBeTypeOf("function");
    expect(oldOpen).toBeTypeOf("function");
    expect(oldRow?.session_id).toBe("sess-alpha");
    if (!oldOpen || !oldRow) throw new Error("Missing actual row callback or selected row");

    await user.clear(screen.getByLabelText("조회 기간(일)"));
    await user.type(screen.getByLabelText("조회 기간(일)"), "90");
    await act(async () => view.navigate("?days=7.0&q=alpha"));
    expect(screen.getByLabelText("조회 기간(일)")).toHaveValue(7);
    await act(async () => view.navigate(rawA));
    await ready();
    expect(view.query()).toBe(originalQuery);
    expect(view.lists()).toHaveLength(1);
    await act(async () => oldOpen(oldRow));
    expect(view.details()).toHaveLength(0);
    expect(new URLSearchParams(view.search()).get("session_id")).toBeNull();
    expect(new URLSearchParams(view.search()).get("days")).toBe("07");
    expect(new URLSearchParams(view.search()).get("q")).toBe(" alpha ");

    await user.click(await ready());
    await waitFor(() => expect(view.details()).toHaveLength(1));
    expect(new URLSearchParams(view.search()).get("days")).toBe("07");
    expect(new URLSearchParams(view.search()).get("q")).toBe(" alpha ");
  });

  it("상세 history와 목록 재조회는 초안·오류를 보존하고 같은 값 제출·초기화는 명시 정렬한다", async () => {
    const user = userEvent.setup();
    const view = renderSessions({ route: "?q=alpha" });
    await ready();
    const days = screen.getByLabelText("조회 기간(일)");
    const keyword = screen.getByLabelText("세션 ID · 메시지 검색");
    await user.clear(days);
    await user.type(days, "90");
    await user.clear(keyword);
    await user.type(keyword, "Bearer abcdefghijklmnop");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    expect(view.search()).toBe("?q=alpha");

    await act(async () => view.navigate("?q=alpha&session_id=sess-alpha"));
    await screen.findByRole("dialog");
    await waitFor(() => expect(view.details()).toHaveLength(1));
    await act(async () => view.history(-1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(days).toHaveValue(90);
    expect(keyword).toHaveValue("Bearer abcdefghijklmnop");
    expect(screen.getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    await act(async () => view.history(1));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(view.details()).toHaveLength(2));
    // Controlled list refetch, not a physical activation behind the modal or a real timer tick.
    await act(async () => view.refresh());
    expect(view.lists()).toHaveLength(2);
    expect(view.details()).toHaveLength(2);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(days).toHaveValue(90);
    expect(keyword).toHaveValue("Bearer abcdefghijklmnop");
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("인증정보로 보이는 검색어");
    await act(async () => view.history(-1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.clear(days);
    await user.type(days, "007");
    await user.clear(keyword);
    await user.type(keyword, " alpha ");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(view.search()).toBe("?q=alpha");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(days).toHaveDisplayValue("7");
    expect(keyword).toHaveValue("alpha");
    await user.clear(days);
    await user.type(days, "90");
    await user.click(screen.getByRole("button", { name: "초기화" }));
    expect(view.search()).toBe("");
    expect(days).toHaveValue(7);
    expect(keyword).toHaveValue("");
  });

  it("목록 첫 요청이 최종 실패해도 외부 목록의 직접 상세는 같은 DOM과 단일 GET을 유지한다", async () => {
    const pending = deferred<unknown>();
    const view = renderSessions({
      route: "?days=30&session_id=outside",
      initialList: () => pending.promise,
    });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(view.details()).toHaveLength(1));
    expect(view.details()[0]?.path).toBe("/admin/sessions/outside/flight-recorder");
    const actualListQuery = view.query();
    expect(actualListQuery?.options.queryFn).toBeTypeOf("function");
    await act(async () => pending.reject(failure()));
    await waitFor(() => expect(view.query()?.state.status).toBe("error"));
    await waitFor(() => expect(screen.getByText(/req_independent_sessions/u)).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(view.details()).toHaveLength(1);
    expect(view.search()).toBe("?days=30&session_id=outside");
    expect(screen.queryByRole("region", { name: "세션 요약", hidden: true })).not.toBeInTheDocument();
    view.reply(async () => ({ days: 30, sessions: [], note: "" }));
    await act(async () => view.refresh());
    await waitFor(() => expect(view.query()?.state.status).toBe("success"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(view.details()).toHaveLength(1);
    expect(view.lists()).toHaveLength(2);
  });
});
