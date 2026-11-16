import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { deferred, renderRecorder, response } from "./flight-recorder-test-harness";

const denied = (requestId = "public-denial-id") =>
  new AppError("PRIVATE_ERROR_BODY", {
    kind: "permission",
    status: 403,
    requestId,
  });

describe("세션 상세의 서버 조회 거부", () => {
  it.each([401, 403])("removes prior records and cached data after HTTP %s", async (status) => {
    const view = renderRecorder();
    await screen.findByText("req-a");
    view.reply(async () => {
      throw new AppError("synthetic denied", { kind: status === 403 ? "permission" : "auth", status });
    });
    await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    const data = view.client
      .getQueryCache()
      .findAll({ queryKey: ["observability", "sessions", "flight-recorder"] })
      .map((query) => query.state.data);
    expect({
      visible: screen.queryByText("req-a") !== null,
      cached: JSON.stringify(data).includes('"req-a"'),
    }).toEqual({ visible: false, cached: false });
    expect(view.details()).toHaveLength(2);
  });

  it("requires a new explicit retry and retires old query, refresh and export callbacks", async () => {
    const view = renderRecorder();
    await screen.findByText("req-a");
    const oldQuery = view.query();
    const queryFn = oldQuery.options.queryFn;
    if (typeof queryFn !== "function") throw new Error("Missing real query function");
    const oldExport = view.captured();
    const oldRefresh = view.captured("비행기록 다시 조회");
    view.reply(async () => {
      throw denied();
    });
    await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveFocus();
    expect(notice).toHaveTextContent("public-denial-id");
    expect(notice).not.toHaveTextContent("PRIVATE_ERROR_BODY");
    await act(async () => {
      oldExport();
      oldRefresh();
    });
    await expect(
      queryFn({
        client: view.client,
        queryKey: oldQuery.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(view.details()).toHaveLength(2);
    expect(view.downloads).toHaveLength(0);
    const pending = deferred<ReturnType<typeof response>>();
    view.reply(async () => pending.promise);
    await userEvent.click(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await waitFor(() => expect(view.details()).toHaveLength(3));
    expect(screen.queryByText("req-a")).not.toBeInTheDocument();
    expect(view.query()).not.toBe(oldQuery);
    await act(async () => pending.resolve(response()));
    await screen.findByText("req-a");
    await act(async () => {
      oldExport();
      oldRefresh();
    });
    expect(view.downloads).toHaveLength(0);
    expect(view.details()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));
    expect(view.downloads).toHaveLength(1);
  });

  it.each(["corp_" + "x".repeat(32), "bad/id", "x".repeat(129)])(
    "does not display unsafe diagnostic %s",
    async (requestId) => {
      const view = renderRecorder();
      await screen.findByText("req-a");
      view.reply(async () => {
        throw denied(requestId);
      });
      await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
      const notice = await screen.findByRole("alert");
      expect(notice).not.toHaveTextContent(requestId);
      expect(notice).not.toHaveTextContent("PRIVATE_ERROR_BODY");
    },
  );

  it("preserves an independently authorized open recorder when the list is denied", async () => {
    const view = renderRecorder({ page: true, route: "?session_id=sess-alpha" });
    await screen.findByText("req-a");
    const dialog = screen.getByRole("dialog");
    const query = view.query();
    const exportButton = within(dialog).getByRole("button", { name: "CSV 내보내기" });
    exportButton.focus();
    view.listReply(async () => {
      throw denied();
    });
    await act(async () =>
      view.client.refetchQueries({
        queryKey: ["observability", "sessions"],
        type: "active",
        predicate: (entry) => entry.queryKey[2] !== "flight-recorder",
      }),
    );
    await waitFor(() => expect(screen.getByText("세션 목록 조회가 거부되었습니다.")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(exportButton).toHaveFocus();
    expect(view.query()).toBe(query);
    expect(query.state.data).toBeDefined();
    await userEvent.click(exportButton);
    expect(view.downloads).toHaveLength(1);
    expect(view.details()).toHaveLength(1);
  });

  it("preserves authorized list data when only its recorder is denied", async () => {
    const view = renderRecorder({ page: true, route: "?session_id=sess-alpha" });
    await screen.findByText("req-a");
    const lists = view.client.getQueryCache().findAll({
      queryKey: ["observability", "sessions"],
      predicate: (entry) => entry.queryKey[2] !== "flight-recorder",
    });
    const prior = lists.map((entry) => entry.state.data);
    expect(prior[0]).toBeDefined();
    view.reply(async () => {
      throw denied();
    });
    await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
    await screen.findByText("비행기록 조회가 거부되었습니다.");
    expect(lists.map((entry) => entry.state.data)).toEqual(prior);
    for (const entry of lists) expect(view.client.getQueryCache().get(entry.queryHash)).toBe(entry);
    expect(screen.queryByText("세션 목록 조회가 거부되었습니다.")).not.toBeInTheDocument();
  });
});
