import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { capturedClicks, flow, renderRequests } from "./request-safe-flow-test-harness";

describe("요청 상세의 단계 조회 거부", () => {
  it.each([401, 403])(
    "retires denied flow after HTTP %s and recovers inside the same authorized dialog",
    async (status) => {
      const view = renderRequests();
      await userEvent.click(await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" }));
      const dialog = screen.getByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "처리 단계 보기" }));
      await screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
      const oldQuery = view.client
        .getQueryCache()
        .find({ queryKey: ["admin", "app-request-flow"], exact: false });
      const oldRetry = capturedClicks.get("단계 기록 다시 조회");
      if (!oldQuery || !oldRetry) throw new Error("Missing live flow query and callback");
      view.replyFlow(async () => {
        throw new AppError("PRIVATE_FLOW_DENIAL", { kind: status === 401 ? "auth" : "permission", status });
      });
      await userEvent.click(within(dialog).getByRole("button", { name: "단계 기록 다시 조회" }));
      const notice = await within(dialog).findByRole("alert");
      expect(notice).toHaveFocus();
      expect(screen.queryByRole("table", { name: "기록된 요청 단계와 시간" })).not.toBeInTheDocument();
      expect(view.client.getQueryCache().get(oldQuery.queryHash)?.state.data).toBeUndefined();
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(view.listCalls()).toHaveLength(1);
      await act(async () => oldRetry());
      expect(view.flowCalls()).toHaveLength(2);
      view.replyFlow(async () => structuredClone(flow));
      await userEvent.click(within(notice).getByRole("button", { name: "권한 확인 후 다시 조회" }));
      await screen.findByRole("table", { name: "기록된 요청 단계와 시간" });
      await waitFor(() => expect(view.flowCalls()).toHaveLength(3));
      await act(async () => oldRetry());
      expect(view.flowCalls()).toHaveLength(3);
      expect(screen.getByRole("dialog")).toBe(dialog);
    },
  );
});
