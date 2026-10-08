import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { domainReviewAcknowledged } from "./domain-review-state";
import { deferred, domainToasts, reviewRow, setupDomainReview } from "./domain-review-test-harness";

function httpResponse(status: number, reason = reviewRow.reason) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { items: [{ ...reviewRow, reason }] }
        : {
            error: {
              message: "public synthetic read denial or outage",
              type: status === 403 ? "permission_error" : "server_error",
              code:
                status === 403
                  ? "raw_prompt_access_required"
                  : status === 401
                    ? "invalid_api_key"
                    : "domain_review_failed",
            },
          },
    ),
    { status, headers: { "Content-Type": "application/json", "X-Request-ID": "public-read-denial" } },
  );
}

async function setupHTTPReview() {
  const current = await setupDomainReview();
  let response = () => Promise.resolve(httpResponse(200));
  const calls: Array<{ method: string; path: string; status?: number }> = [];
  current.response.reviewClient = new ApiClient({
    fetch: async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        path: new URL(String(input), "https://synthetic.invalid").pathname,
        status: undefined as number | undefined,
      };
      calls.push(call);
      const result = await response();
      call.status = result.status;
      return result;
    },
  });
  // Establish success through the real HTTP parser. The auth role, scopes and
  // capability remain unchanged; these tests exercise server-side GET denial.
  await act(async () => {
    await current.actualQuery().fetch();
  });
  const reviewQueries = () =>
    current.view.client
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.queryKey[0] === "routing" && query.queryKey[1] === "domain" && query.queryKey[2] === "review",
      );
  const refetch = async () => {
    const query = current.actualQuery();
    await act(async () => {
      await query.fetch().catch(() => undefined);
    });
  };
  return {
    ...current,
    httpCalls: calls,
    reviewQueries,
    refetch,
    reply(status: number, reason = reviewRow.reason) {
      response = () => Promise.resolve(httpResponse(status, reason));
    },
    hold(promise: Promise<Response>) {
      response = () => promise;
    },
    assertRetired() {
      expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
      expect(document.body.textContent?.includes(reviewRow.reason)).toBe(false);
      expect(
        reviewQueries().some((query) => JSON.stringify(query.state.data)?.includes(reviewRow.reason)),
      ).toBe(false);
      expect(document.body.textContent?.includes("현재 응답에 검토 항목이 없습니다.")).toBe(false);
      expect(current.writes()).toHaveLength(0);
      expect(
        calls.every((call) => call.method === "GET" && call.path === "/admin/routing/domain-review"),
      ).toBe(true);
    },
  };
}

describe("도메인 검토 — 서버의 원문 조회 거부 경계", () => {
  it.each([401, 403])("GET %d가 이전 행, 선택, 캐시와 옛 콜백을 폐기한다", async (status) => {
    const current = await setupHTTPReview();
    const original = current.actualQuery();
    const learning = current.view.client
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "learning");
    const opened = await current.open("approve", true);
    const oldSave = current.capture(opened.label);
    const oldRefresh = current.capture("검토 목록 다시 조회");
    current.reply(status);
    await current.refetch();
    expect(current.httpCalls.at(-1)?.status).toBe(status);
    current.assertRetired();
    expect(current.view.client.getQueryCache().getAll()).not.toContain(original);
    expect(current.view.client.getQueryCache().getAll()).toContain(learning);
    const reads = current.httpCalls.length;
    await act(async () => {
      await oldSave();
      await oldRefresh();
    });
    expect(current.httpCalls).toHaveLength(reads);
    expect(current.writes()).toHaveLength(0);
  });

  it("403 뒤 명시적 복구의 503은 이전 행이나 상세를 되살리지 않는다", async () => {
    const current = await setupHTTPReview();
    await current.open("approve", false);
    current.reply(403);
    await current.refetch();
    current.assertRetired();
    current.reply(503);
    await current.user.click(screen.getByRole("button", { name: "검토 목록 다시 조회" }));
    await waitFor(() => expect(current.actualQuery().state.error).toMatchObject({ status: 503 }));
    current.assertRetired();
    expect(current.actualQuery().state.data).toBeUndefined();
    expect(current.actualQuery().state.status).toBe("error");
  });

  it("복구의 새 200은 깨끗한 조회를 만들고 옛 상세와 동의를 자동 복구하지 않는다", async () => {
    const current = await setupHTTPReview();
    const original = current.actualQuery();
    const opened = await current.open("approve", true);
    const oldSave = current.capture(opened.label);
    current.reply(403);
    await current.refetch();
    current.assertRetired();
    const freshReason = "PUBLIC-FRESH-REVIEW-METADATA";
    current.reply(200, freshReason);
    await current.user.click(screen.getByRole("button", { name: "검토 목록 다시 조회" }));
    await waitFor(() => expect(current.actualQuery().state.status).toBe("success"));
    expect(current.actualQuery()).not.toBe(original);
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(reviewRow.reason)).toBe(false);
    expect(document.body.textContent?.includes(freshReason)).toBe(true);
    await act(async () => {
      await oldSave();
    });
    expect(current.writes()).toHaveLength(0);
    const fresh = await current.open("approve", false);
    expect(fresh.dialog).toHaveTextContent(freshReason);
    expect(within(fresh.dialog).getByRole("checkbox")).not.toBeChecked();
  });

  it("403 뒤 복구 GET의 취소와 늦은 200이 이전 성공 캐시를 복구하지 않는다", async () => {
    const current = await setupHTTPReview();
    await current.open("approve", false);
    current.reply(403);
    await current.refetch();
    current.assertRetired();
    const held = deferred<Response>();
    current.hold(held.promise);
    await current.user.click(screen.getByRole("button", { name: "검토 목록 다시 조회" }));
    const recovery = current.actualQuery();
    await waitFor(() => expect(recovery.state.fetchStatus).toBe("fetching"));
    await act(async () => {
      await current.view.client.cancelQueries({ queryKey: recovery.queryKey, exact: true }, { revert: true });
    });
    current.assertRetired();
    expect(recovery.state.data).toBeUndefined();
    await act(async () => {
      held.resolve(httpResponse(200));
      await held.promise;
    });
    current.assertRetired();
    expect(recovery.state.data).toBeUndefined();
  });

  it("취소된 이전 GET의 늦은 403은 새 성공 조회를 거부 상태로 바꾸지 않는다", async () => {
    const current = await setupHTTPReview();
    const original = current.actualQuery();
    const held = deferred<Response>();
    current.hold(held.promise);
    let old = Promise.resolve<unknown>(undefined);
    act(() => {
      old = original.fetch().catch(() => undefined);
    });
    await act(async () => {
      await current.view.client.cancelQueries({ queryKey: original.queryKey, exact: true }, { revert: true });
    });
    const freshReason = "PUBLIC-FRESH-AFTER-CANCEL";
    current.reply(200, freshReason);
    await current.refetch();
    await act(async () => {
      held.resolve(httpResponse(403));
      await held.promise;
      await old;
    });
    expect(current.actualQuery().state.status).toBe("success");
    expect(document.body.textContent?.includes(freshReason)).toBe(true);
    expect(document.body.textContent?.includes("서버가 조회를 허용하지 않아")).toBe(false);
    expect(current.writes()).toHaveLength(0);
  });

  it("거부가 없던 일반 503은 허용된 이전 자료를 경고와 함께 유지한다", async () => {
    const current = await setupHTTPReview();
    await current.open("approve", false);
    current.reply(503);
    await current.refetch();
    expect(current.actualQuery().state.error).toMatchObject({ status: 503 });
    expect(Boolean(screen.queryByRole("dialog"))).toBe(true);
    expect(document.body.textContent?.includes(reviewRow.reason)).toBe(true);
    expect(current.actualQuery().state.data).toBeDefined();
    expect(document.body.textContent?.includes("이전 결과를 표시합니다.")).toBe(true);
    expect(current.writes()).toHaveLength(0);
  });

  it("기록 POST 중 독립 GET 403 뒤 늦은 ACK는 알림, 후속 GET, 자동 재기록을 하지 않는다", async () => {
    const current = await setupHTTPReview();
    const held = deferred<Response>();
    const postCalls: Array<{ method: string; hasBody: boolean; signal?: AbortSignal | null }> = [];
    const postClient = new ApiClient({
      fetch: async (_input, init) => {
        postCalls.push({
          method: init?.method ?? "GET",
          hasBody: init?.body !== undefined,
          signal: init?.signal,
        });
        // Deliberately ignore abort to model an ACK arriving after the UI owner
        // retires. Aborting the browser request does not prove server rollback.
        return held.promise;
      },
    });
    const request = postClient.request.bind(postClient);
    let postSettled: Promise<unknown> = Promise.resolve();
    vi.spyOn(postClient, "request").mockImplementation((endpoint, ...args) => {
      const result = request(endpoint, ...args);
      postSettled = result.catch(() => undefined);
      return result;
    });
    current.response.postClient = postClient;
    const opened = await current.open("approve", true);
    const oldSave = current.capture(opened.label);
    await current.user.click(opened.confirm);
    expect(current.writes()).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.method).toBe("POST");
    expect(postCalls[0]?.hasBody).toBe(false);

    current.reply(403);
    await current.refetch();
    expect(current.httpCalls.at(-1)?.status).toBe(403);
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(reviewRow.reason)).toBe(false);
    expect(current.reviewQueries()).toHaveLength(0);
    expect(postCalls[0]?.signal?.aborted).toBe(true);
    const reads = current.httpCalls.length;
    await act(async () => {
      held.resolve(
        new Response(JSON.stringify({ id: reviewRow.id, status: "approved" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await postSettled;
      await oldSave();
    });
    expect(domainToasts().success).not.toHaveBeenCalled();
    expect(domainToasts().error).not.toHaveBeenCalled();
    expect(current.httpCalls).toHaveLength(reads);
    expect(current.writes()).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(current.reviewQueries()).toHaveLength(0);
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(domainReviewAcknowledged)).toBe(false);
  });

  it("열린 상세가 403으로 제거된 뒤 포커스는 새 거부 안내 제목에 남는다", async () => {
    const main = document.createElement("main");
    main.id = "main-content";
    main.tabIndex = -1;
    document.body.append(main);
    try {
      const current = await setupHTTPReview();
      await current.open("approve", false);
      current.reply(403);
      await current.refetch();
      current.assertRetired();
      // Radix schedules close-autofocus after unmount; assert the final target,
      // not only the denial heading's earlier layout-effect focus.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const heading = screen.getByRole("heading", { name: "도메인 라우팅 검토 큐" }).querySelector("span");
      expect(heading).not.toBeNull();
      expect(document.activeElement === heading).toBe(true);
    } finally {
      main.remove();
    }
  });
});
