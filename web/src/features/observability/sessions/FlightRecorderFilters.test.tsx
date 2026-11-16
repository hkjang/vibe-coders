import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { deferred, failure, renderRecorder, response, runtime } from "./flight-recorder-test-harness";

function records() {
  const body = response();
  const seed = body.events[0];
  if (!seed) throw new Error("Missing fixture");
  return {
    ...body,
    rollup: { ...body.rollup, requests: 3 },
    events: [
      { ...seed, request_id: "normal-row", is_error: false },
      { ...seed, request_id: "error-row", is_error: true, created_at: "2026-10-01T01:00:01Z" },
      {
        ...seed,
        request_id: "risk-row",
        kind: "messages",
        is_error: false,
        secret_events: 1,
        tool_count: 2,
        created_at: "2026-10-01T01:00:02Z",
      },
    ],
  };
}
const list = () => screen.getByRole("list", { name: "표시 중인 세션 기록" });
const ready = () => screen.findByRole("combobox", { name: "기록 조건" });

describe("세션 기록 필터와 내보내기", () => {
  it("narrows locally, keeps source totals and offsets, and exports only the visible rows in order", async () => {
    const view = renderRecorder({ reply: async () => records() });
    await ready();
    const summary = screen.getByRole("region", { name: "수신 기록 집계" });
    const original = summary.textContent;
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "표시 순서" }), "newest");
    expect(within(list()).getAllByRole("listitem")[0]).toHaveTextContent("risk-row");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "기록 조건" }), "risk");
    expect(screen.getByRole("status", { name: "세션 기록 표시 범위" })).toHaveTextContent(
      "수신 3건 중 1건 표시",
    );
    expect(list()).toHaveTextContent("첫 기록 대비 +2.0s");
    expect(summary.textContent).toBe(original);
    await userEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));
    expect(view.downloads[0]?.content).toContain("risk-row");
    expect(view.downloads[0]?.content).not.toMatch(/normal-row|error-row|NOT_A_CSV_COLUMN/);
    expect(view.details()).toHaveLength(1);
  });
  it("distinguishes empty filters from an empty response and restores without another request", async () => {
    const view = renderRecorder({ reply: async () => records() });
    await ready();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "요청 유형" }), "embedding");
    expect(screen.getByText("조건에 맞는 수신 기록이 없습니다.")).toBeVisible();
    expect(screen.queryByText("이 응답에서 확인할 기록이 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "모든 수신 기록 보기" }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
    expect(view.details()).toHaveLength(1);
  });
  it("retains filters during refresh and blocks old filtered exports until a current success", async () => {
    const view = renderRecorder({ reply: async () => records() });
    await ready();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "기록 조건" }), "error");
    expect(within(list()).getByText("HTTP 200 · 오류 기록")).toBeVisible();
    const oldExport = view.captured();
    const pending = deferred<unknown>();
    view.reply(async () => pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
    await act(async () => oldExport());
    expect(view.downloads).toHaveLength(0);
    expect(screen.getByRole("combobox", { name: "기록 조건" })).toHaveValue("error");
    await act(async () => pending.reject(failure()));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    await act(async () => view.captured()());
    expect(view.downloads).toHaveLength(0);
    view.reply(async () => records());
    await userEvent.click(screen.getByRole("button", { name: "비행기록 다시 조회" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "CSV 내보내기" })).toHaveAttribute("aria-disabled", "false"),
    );
    await userEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));
    expect(view.downloads[0]?.content).toContain("error-row");
    expect(view.downloads[0]?.content).not.toContain("normal-row");
  });
  it.each(["target", "owner", "reopen"] as const)(
    "resets the local filter after %s changes",
    async (boundary) => {
      const view = renderRecorder({ reply: async () => records() });
      await ready();
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "기록 조건" }), "risk");
      await act(async () => {
        if (boundary === "target") view.target("another-session");
        else if (boundary === "owner") {
          runtime.id = "reader-b";
          view.rerenderRuntime();
        } else view.open(false);
      });
      if (boundary === "reopen") await act(async () => view.open(true));
      expect(await ready()).toHaveValue("all");
      expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
    },
  );
});
