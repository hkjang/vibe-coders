import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { deferred, domainToasts, reviewRow, setupDomainReview } from "./domain-review-test-harness";

describe("도메인 검토의 상태 기록과 현재 검토 수명", () => {
  it.each(["approve", "reject"] as const)("정상 %s는 원래 ID에 본문 없는 요청을 보낸다", async (action) => {
    const current = await setupDomainReview(),
      opened = await current.open(action);
    expect(current.writes()).toHaveLength(0);
    await current.user.click(opened.confirm);
    await waitFor(() => expect(current.writes()).toHaveLength(1));
    await waitFor(() => expect(current.rows[0]?.status).toBe(action === "approve" ? "approved" : "rejected"));
    expect(decodeURIComponent(current.writes()[0]?.key ?? "")).toBe(
      `POST /admin/routing/domain-review/rv_1/${action}`,
    );
    expect(current.writes()[0]?.body).toBeUndefined();
    await waitFor(() =>
      expect(
        current.calls.filter((call) => call.key === "GET /admin/routing/domain-review").length,
      ).toBeGreaterThan(1),
    );
  });
  it.each(["readonly", "write"])("열린 확인창의 %s 회수 뒤 전송하지 않는다", async (kind) => {
    const current = await setupDomainReview(),
      opened = await current.open();
    current.update(kind === "readonly" ? { readOnly: true } : { scopes: ["routing:read"] });
    await current.user.click(opened.confirm);
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.writes()).toHaveLength(0);
  });
  it.each(["invalidated", "fetching", "status"])(
    "현재 콜백도 실제 Query %s 변경을 다시 확인한다",
    async (kind) => {
      const current = await setupDomainReview(),
        query = current.actualQuery();
      await act(async () => {
        await query.fetch();
      });
      const opened = await current.open(),
        confirm = current.capture(opened.label),
        hold = deferred<unknown>();
      let pending: Promise<unknown> | undefined;
      await act(async () => {
        if (kind === "invalidated") query.invalidate();
        else if (kind === "fetching") {
          current.response.review = () => hold.promise;
          pending = query.fetch();
        } else
          query.setData(
            { items: [{ ...reviewRow, status: "approved" }] },
            { manual: true, updatedAt: query.state.dataUpdatedAt },
          );
        void confirm();
        await Promise.resolve();
      });
      const attempts = current.writes().length;
      if (pending) {
        hold.resolve({ items: [{ ...reviewRow }] });
        await act(async () => {
          await pending;
        });
      }
      expect(attempts).toBe(0);
    },
  );
  it.each([{}, { id: "another", status: "approved" }, { id: "rv_1", status: "rejected" }])(
    "불명확한 ACK %j는 성공·창닫기로 처리하지 않는다",
    async (ack) => {
      const current = await setupDomainReview(),
        opened = await current.open();
      current.response.action = () => ack;
      await current.user.click(opened.confirm);
      await waitFor(() => expect(current.writes()).toHaveLength(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(domainToasts().success).not.toHaveBeenCalled();
      expect(opened.dialog).toBeInTheDocument();
    },
  );
  it("응답 유실 뒤 같은 창에서 다시 POST하지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    current.response.action = () => {
      throw new AppError("합성 응답 유실", { kind: "network" });
    };
    await current.user.click(opened.confirm);
    await within(opened.dialog).findByRole("alert");
    expect(current.writes()).toHaveLength(1);
    await current.user.click(within(opened.dialog).getByRole("button", { name: opened.label }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.writes()).toHaveLength(1);
  });
  it("새 성공 캐시에 프롬프트 원문을 보관하지 않는다", async () => {
    const current = await setupDomainReview();
    expect(JSON.stringify(current.actualQuery().state.data)).not.toContain(reviewRow.query_text);
    expect(JSON.stringify(current.actualQuery().state.data)).not.toContain("query_text");
  });
  it("승인을 학습 예시 승격과 이후 라우팅 변경으로 안내하지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    expect(opened.dialog).not.toHaveTextContent("승격되어 이후 라우팅에 반영됩니다");
  });
  it("승인된 항목을 검토 대기 건수로 세지 않는다", async () => {
    await setupDomainReview("approved");
    const card = screen.getByText("검토 대기", { selector: ".stat-card-label span" }).closest("article");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".stat-card-value")).toHaveTextContent("—");
  });
});
