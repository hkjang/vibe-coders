import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { deferred, list, renderSessions, table } from "./session-list-test-harness";

describe("세션 목록의 서버 조회 거부", () => {
  it.each([401, 403])("removes prior rows and cached data after HTTP %s", async (status) => {
    const view = renderSessions();
    await screen.findByText("합성 메시지");
    view.reply(async () => {
      throw new AppError("synthetic denied", { kind: status === 403 ? "permission" : "auth", status });
    });
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    const data = view.client
      .getQueryCache()
      .findAll({ queryKey: ["observability", "sessions"] })
      .map((query) => query.state.data);
    expect({
      visible: screen.queryByText("합성 메시지") !== null,
      cached: JSON.stringify(data).includes("합성 메시지"),
    }).toEqual({ visible: false, cached: false });
  });

  it("purges all period caches and blocks old rows and queries through explicit recovery", async () => {
    const view = renderSessions();
    await screen.findByText("합성 메시지");
    const oldQuery = view.query();
    if (!oldQuery || typeof oldQuery.options.queryFn !== "function") throw new Error("Missing query");
    const oldQueryFn = oldQuery.options.queryFn;
    const oldRow = table.rows[0];
    const oldOpen = table.open;
    if (!oldRow || !oldOpen) throw new Error("Missing actual row action");
    await act(async () => view.navigate("?days=30"));
    await waitFor(() => expect(view.lists()).toHaveLength(2));
    await waitFor(() => expect(view.query()?.state.status).toBe("success"));
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["observability", "sessions"] })
        .filter((query) => query.state.data !== undefined),
    ).toHaveLength(2);
    view.reply(async () => {
      throw new AppError("PRIVATE_DENIAL_BODY", {
        kind: "permission",
        status: 403,
        requestId: "safe-list-denial",
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveFocus();
    expect(notice).toHaveTextContent("safe-list-denial");
    expect(notice).not.toHaveTextContent("PRIVATE_DENIAL_BODY");
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["observability", "sessions"] })
        .some((query) => query.state.data !== undefined),
    ).toBe(false);
    await act(async () => {
      oldOpen(oldRow);
      view.navigate("?days=7");
    });
    expect(view.lists()).toHaveLength(3);
    expect(view.details()).toHaveLength(0);
    expect(screen.queryByText("합성 메시지")).not.toBeInTheDocument();
    await expect(
      oldQueryFn({
        client: view.client,
        queryKey: oldQuery.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    const pending = deferred<ReturnType<typeof list>>();
    view.reply(async () => pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await waitFor(() => expect(view.lists()).toHaveLength(4));
    expect(screen.queryByText("합성 메시지")).not.toBeInTheDocument();
    await act(async () => pending.resolve(list()));
    await screen.findByText("합성 메시지");
    expect(view.query()).not.toBe(oldQuery);
    await act(async () => oldOpen(oldRow));
    expect(view.details()).toHaveLength(0);
  });
});
