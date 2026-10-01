import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { deferred, list, renderSessions, row, runtime, table } from "./session-list-test-harness";

const openName = "sess-alpha 세션 비행기록 열기";
const ready = () => screen.findByRole("button", { name: openName });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected captured test value");
  return value;
}
const failure = () =>
  new AppError("목록 조회 오류", { kind: "http", status: 503, requestId: "req_session_safe" });

describe("세션 목록 조회 기준", () => {
  it.each(["authenticated", "legacy", "open"] as const)(
    "정상 대조: %s + readonly에서 실제 목록과 상세 GET",
    async (mode) => {
      const view = renderSessions({ auth: { mode } });
      await userEvent.click(await ready());
      expect(table.readOnly).toBe(true);
      expect(await screen.findByRole("dialog", { name: "세션 비행기록" })).toBeVisible();
      await waitFor(() => expect(view.details()).toHaveLength(1));
      expect(view.lists()[0]?.query).toEqual({ days: 7 });
    },
  );
  it("직접 상세는 목록에 없어도 정상 조회한다", async () => {
    const view = renderSessions({
      route: "?session_id=outside",
      initialList: async () => ({ days: 7, sessions: [] }),
    });
    expect(await screen.findByRole("dialog")).toBeVisible();
    await waitFor(() => expect(view.details()).toHaveLength(1));
  });
  it("새 기간 보류의 표·합계는 이전 응답 기간이고 실제 버튼의 초점/DOM을 보존한다", async () => {
    const view = renderSessions();
    const button = await ready();
    const gate = deferred<unknown>();
    view.reply(() => gate.promise);
    await act(async () => view.navigate("?days=30"));
    expect(await screen.findByText("최근 30일 조회 중 · 아래 표와 합계는 이전 7일 결과")).toBeVisible();
    expect(screen.getByRole("button", { name: openName })).toBe(button);
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(button).toHaveFocus();
    expect(view.details()).toHaveLength(0);
    expect(view.search()).toBe("?days=30");
    expect(screen.getByText("현재 목록을 다시 확인한 뒤 세션을 선택하세요.")).toBeVisible();
    await act(async () => gate.resolve(list(30)));
    await screen.findByText("아래 표와 합계는 최근 30일 응답의 검색 결과입니다.");
    expect(screen.queryByText("현재 목록을 다시 확인한 뒤 세션을 선택하세요.")).not.toBeInTheDocument();
  });
  it("미캐시 새 기간 실패에 이전 데이터/가짜0을 만들지 않고 열린 상세는 유지한다", async () => {
    const view = renderSessions();
    await userEvent.click(await ready());
    const dialog = await screen.findByRole("dialog");
    view.reply(async () => {
      throw failure();
    });
    await act(async () => view.navigate("?days=30&session_id=sess-alpha"));
    await waitFor(() => expect(view.query()?.state.status).toBe("error"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(view.details()).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "세션 요약", hidden: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText("조회 기간(일)")).toHaveValue(30);
  });
  it("같은 기간 재조회 실패는 마지막 정상 표와 합계를 표시하되 새 선택은 막는다", async () => {
    const view = renderSessions();
    const button = await ready();
    view.reply(async () => {
      throw failure();
    });
    await act(async () => view.refresh());
    expect(await screen.findByText("최근 7일 조회 실패 · 아래 표와 합계는 이전 7일 결과")).toBeVisible();
    await userEvent.click(button);
    expect(view.details()).toHaveLength(0);
    expect(screen.getByRole("button", { name: openName })).toBe(button);
  });
  it("days/q URL 변경만 입력을 정렬하고 session_id 변경은 미제출 초안을 보존한다", async () => {
    const view = renderSessions();
    await ready();
    await userEvent.clear(screen.getByLabelText("조회 기간(일)"));
    await userEvent.type(screen.getByLabelText("조회 기간(일)"), "90");
    await userEvent.type(screen.getByLabelText("세션 ID · 메시지 검색"), "미제출");
    await act(async () => view.navigate("?session_id=sess-alpha"));
    expect(screen.getByLabelText("조회 기간(일)")).toHaveValue(90);
    expect(screen.getByLabelText("세션 ID · 메시지 검색")).toHaveValue("미제출");
    await act(async () => view.navigate("?days=30&q=alpha"));
    expect(screen.getByLabelText("조회 기간(일)")).toHaveValue(30);
    expect(screen.getByLabelText("세션 ID · 메시지 검색")).toHaveValue("alpha");
  });
  it("q 왕복으로 같은 Query/data가 돌아와도 캡처 행 콜백은 영구 폐기한다", async () => {
    const view = renderSessions();
    await ready();
    const old = table.open;
    const selected = table.rows[0];
    expect(old).toBeTypeOf("function");
    expect(selected).toBeDefined();
    await act(async () => view.navigate("?q=없는검색"));
    await act(async () => view.navigate(""));
    await ready();
    await act(async () => required(old)(required(selected)));
    expect(view.search()).toBe("");
    expect(view.details()).toHaveLength(0);
    expect(view.lists()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: openName }));
    await waitFor(() => expect(view.details()).toHaveLength(1));
  });
  it.each(["invalidate", "identical-success"] as const)(
    "React 알림 전 %s 뒤 옛 콜백을 차단한다",
    async (mode) => {
      const view = renderSessions();
      await ready();
      const old = table.open;
      const selected = table.rows[0];
      const query = view.query();
      expect(query?.options.queryFn).toBeTypeOf("function");
      expect(old).toBeTypeOf("function");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      await act(async () => {
        if (mode === "invalidate") required(query).invalidate();
        else required(query).setData(required(query).state.data);
        required(old)(required(selected));
      });
      clock.mockRestore();
      expect(view.details()).toHaveLength(0);
      expect(view.search()).toBe("");
      if (mode === "identical-success") {
        await userEvent.click(await ready());
        await waitFor(() => expect(view.details()).toHaveLength(1));
      }
    },
  );
  it("actual Query.fetch 정상 대조는 요청을 수행하며 오류가 없는 현재 행은 열 수 있다", async () => {
    const view = renderSessions();
    await ready();
    const query = view.query();
    expect(query?.options.queryFn).toBeTypeOf("function");
    await act(async () => {
      await required(query).fetch();
    });
    expect(view.lists()).toHaveLength(2);
    await userEvent.click(await ready());
    await waitFor(() => expect(view.details()).toHaveLength(1));
  });
  it("admin read가 없으면 serverAvailable가 참이어도 목록을 요청하지 않는다", async () => {
    const view = renderSessions({ auth: { scopes: [] } });
    expect(await screen.findByText("현재 세션 목록 조회 권한을 확인하세요.")).toBeVisible();
    expect(view.lists()).toHaveLength(0);
  });
  it("현재 설정 접두사 검색어는 URL 기록 전에 거부한다", async () => {
    const view = renderSessions();
    await ready();
    await userEvent.type(screen.getByLabelText("세션 ID · 메시지 검색"), `corp_${"x".repeat(40)}`);
    await userEvent.click(screen.getByRole("button", { name: "조회" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    expect(view.search()).toBe("");
  });
  it("잘못된 응답 기간은 0합계나 현재기간으로 보정하지 않고 행 시작을 막는다", async () => {
    const view = renderSessions({ initialList: async () => ({ ...list(), days: 0 }) });
    await ready();
    expect(screen.getByText("응답 기간 미확인")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: openName }));
    expect(view.details()).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "세션 요약" })).not.toBeInTheDocument();
  });
  it("검색0과 응답0을 구분하고 q는 서버로 보내지 않는다", async () => {
    const view = renderSessions({ route: "?q=없는검색" });
    expect(await screen.findByText("불러온 세션에서 검색 결과가 없습니다.")).toBeVisible();
    expect(view.lists()[0]?.query).toEqual({ days: 7 });
  });
  it("owner/team 왕복 중 이전 목록을 노출하지 않고 오래된 GET 콜백도 막는다", async () => {
    const view = renderSessions();
    await ready();
    const query = view.query();
    const queryFn = query?.options.queryFn;
    expect(queryFn).toBeTypeOf("function");
    const old = table.open;
    const selected = table.rows[0];
    const gate = deferred<unknown>();
    view.reply(() => gate.promise);
    runtime.team = "team-b";
    view.runtime();
    await waitFor(() => expect(view.lists()).toHaveLength(2));
    expect(screen.queryByText(row.session_id)).not.toBeInTheDocument();
    runtime.team = "team-a";
    view.runtime();
    await waitFor(() => expect(view.lists()).toHaveLength(3));
    await act(async () => gate.resolve(list()));
    await ready();
    await act(async () => required(old)(required(selected)));
    expect(view.details()).toHaveLength(0);
    if (typeof queryFn !== "function" || !query) throw new Error("Expected real list query function");
    await expect(
      queryFn({
        client: view.client,
        queryKey: query.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(view.lists()).toHaveLength(3);
  });
  it("상세 안내는 목록과 별개인 범위이며 원문/PII 제거를 보장하지 않는다", async () => {
    renderSessions();
    await userEvent.click(await ready());
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다."),
    ).toBeVisible();
    expect(dialog).not.toHaveTextContent("프롬프트 원문은 포함되지 않습니다");
  });
  it.each(["scope", "owner", "permission", "epoch"] as const)(
    "%s 수명 폐기 뒤 캡처된 실제 queryFn과 행 콜백은 GET을 만들지 않는다",
    async (boundary) => {
      const view = renderSessions({ actualRoute: boundary === "scope" || boundary === "epoch" });
      await ready();
      const query = view.query();
      const queryFn = query?.options.queryFn;
      const old = table.open;
      const selected = table.rows[0];
      if (!query || typeof queryFn !== "function" || !old || !selected)
        throw new Error("Expected active list callbacks");
      await act(async () => {
        if (boundary === "scope") runtime.scopes = [];
        if (boundary === "owner") runtime.owner = "observability.requests";
        if (boundary === "permission") runtime.permitted = false;
        if (boundary === "epoch") tokenStore.clearAll();
        view.runtime();
      });
      if (boundary !== "epoch") {
        expect(screen.getByText("현재 세션 목록 조회 권한을 확인하세요.")).toBeVisible();
        expect(view.lists()).toHaveLength(1);
        await act(async () => {
          runtime.scopes = ["admin:read"];
          runtime.owner = "observability.sessions";
          runtime.permitted = true;
          view.runtime();
        });
      }
      await ready();
      await waitFor(() => expect(view.lists()).toHaveLength(2));
      await act(async () => old(selected));
      await expect(
        queryFn({
          client: view.client,
          queryKey: query.queryKey,
          signal: new AbortController().signal,
          meta: undefined,
        }),
      ).rejects.toMatchObject({ kind: "aborted" });
      expect(view.lists()).toHaveLength(2);
      expect(view.details()).toHaveLength(0);
      const current = view.query();
      expect(current).not.toBe(query);
      await act(async () => {
        await required(current).fetch();
      });
      expect(view.lists()).toHaveLength(3);
    },
  );
  it("현재 권한 회수 중 늦은 목록 응답은 DOM과 캐시에 게시되지 않는다", async () => {
    const gate = deferred<unknown>();
    const view = renderSessions({ initialList: () => gate.promise });
    await waitFor(() => expect(view.lists()).toHaveLength(1));
    const old = view.query();
    await act(async () => {
      runtime.scopes = [];
      view.runtime();
    });
    await act(async () => gate.resolve(list()));
    expect(screen.queryByText(row.session_id)).not.toBeInTheDocument();
    expect(old?.state.data).toBeUndefined();
    expect(view.lists()).toHaveLength(1);
    view.reply(async () => list());
    await act(async () => {
      runtime.scopes = ["admin:read"];
      view.runtime();
    });
    await ready();
    expect(view.lists()).toHaveLength(2);
  });
  it("닫힌 페이지의 캡처 조회 함수는 현재 권한이 그대로여도 실행하지 않는다", async () => {
    const view = renderSessions();
    await ready();
    const query = view.query();
    const queryFn = query?.options.queryFn;
    if (!query || typeof queryFn !== "function") throw new Error("Expected real query function");
    view.unmount();
    await expect(
      queryFn({
        client: view.client,
        queryKey: query.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(view.lists()).toHaveLength(1);
  });
  it("고정 시각의 실제 동일 응답 재조회도 새 세대이며 현재 콜백은 다시 허용된다", async () => {
    const view = renderSessions();
    await ready();
    const query = view.query();
    const old = table.open;
    const selected = table.rows[0];
    const data = query?.state.data;
    const count = query?.state.dataUpdateCount;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await act(async () => view.refresh());
    clock.mockRestore();
    expect(query?.state.dataUpdateCount).toBe((count ?? 0) + 1);
    expect(query?.state.data).not.toBe(data);
    await act(async () => required(old)(required(selected)));
    expect(view.details()).toHaveLength(0);
    await userEvent.click(await ready());
    await waitFor(() => expect(view.details()).toHaveLength(1));
  });
  it.each([null, undefined, 30, 7.5, Number.MAX_SAFE_INTEGER + 1])(
    "응답 기간 %s는 정규화된 현재 기간으로 추정하지 않는다",
    async (days) => {
      const view = renderSessions({ initialList: async () => ({ ...list(), days }) });
      await ready();
      expect(screen.getByText("응답 기간 미확인")).toBeVisible();
      expect(screen.queryByRole("region", { name: "세션 요약" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: openName }));
      expect(view.details()).toHaveLength(0);
    },
  );
  it("이전 빈 응답 뒤 새 기간 실패는 정상 빈 결과로 표시하지 않는다", async () => {
    const view = renderSessions({ initialList: async () => ({ days: 7, sessions: [] }) });
    await screen.findByText("표시할 세션이 없습니다.");
    view.reply(async () => {
      throw failure();
    });
    await act(async () => view.navigate("?days=30"));
    await waitFor(() => expect(view.query()?.state.status).toBe("error"));
    expect(screen.queryByText("표시할 세션이 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "세션 요약" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("req_session_safe");
  });
  it("런타임 접두사와 같은 오류 요청ID는 표시하지 않지만 수동 재조회는 허용한다", async () => {
    const marker = `corp_${"z".repeat(40)}`;
    const view = renderSessions({
      initialList: async () => {
        throw new AppError("합성 오류", { kind: "http", status: 503, requestId: marker });
      },
    });
    await screen.findByRole("alert");
    expect(document.body.outerHTML).not.toContain(marker);
    view.reply(async () => list());
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await ready();
    expect(view.lists()).toHaveLength(2);
  });
});
