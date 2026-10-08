import { act, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { domainToasts, setupDomainReview } from "./domain-review-test-harness";

it.each(["malformed", "http"])(
  "실제 클라이언트 %s 오류의 응답 본문을 Query 오류 캐시에 보관하지 않는다",
  async (kind) => {
    const current = await setupDomainReview();
    const canary = "PUBLIC-QUERY-ERROR-BODY-CANARY";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          kind === "malformed"
            ? `{"items":[{"query_text":"${canary}"`
            : JSON.stringify({
                error: { message: canary, type: "server_error", code: canary },
                query_text: canary,
              }),
          {
            status: kind === "malformed" ? 200 : 500,
            headers: { "Content-Type": "application/json", "X-Request-ID": "req-public-review" },
          },
        ),
    );
    current.response.reviewClient = new ApiClient({ fetch, getSessionEpoch: () => 0 });
    const query = current.actualQuery();
    await act(async () => {
      await query.fetch().catch(() => undefined);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(query.state.status).toBe("error");
    expect(query.state.error).toMatchObject({ requestId: "req-public-review" });
    expect(query.state.error?.message).not.toContain(canary);
    expect(JSON.stringify(query.state.error)).not.toContain(canary);
    expect(query.state.error?.cause).toBeUndefined();
    expect(query.state.error).toMatchObject({ details: undefined, code: undefined });
  },
);

it("실제 API 클라이언트의 401 자동 갱신·재전송을 상태 기록에서 허용하지 않는다", async () => {
  const current = await setupDomainReview(),
    opened = await current.open();
  const requests: Array<{ path: string; method: string | undefined }> = [];
  let posts = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = String(input);
    requests.push({ path, method: init?.method });
    // Deliberately provide a working refresh route: an incorrectly enabled
    // replay would produce two writes, not merely fail on an unmocked endpoint.
    const refresh = path === "/auth/refresh";
    if (!refresh) posts += 1;
    const status = !refresh && posts === 1 ? 401 : 200;
    const body = refresh
      ? {
          access_token: "public-access-two",
          refresh_token: "public-refresh-two",
          token_type: "Bearer",
          expires_in: 3600,
        }
      : status === 401
        ? { error: { message: "Synthetic expired session", type: "authentication_error" } }
        : { id: "rv_1", status: "approved" };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  const saveTokens = vi.fn();
  current.response.postClient = new ApiClient({
    fetch,
    getAccessToken: () => "public-access-one",
    getRefreshToken: () => "public-refresh-one",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
    saveTokens,
    clearTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  await current.user.click(opened.confirm);
  await within(opened.dialog).findByRole("alert");
  expect(requests).toEqual([{ path: "/admin/routing/domain-review/rv_1%2Fapprove", method: "POST" }]);
  expect(saveTokens).not.toHaveBeenCalled();
  expect(domainToasts().success).not.toHaveBeenCalled();
  expect(current.writes()).toHaveLength(1);
  await current.user.click(within(opened.dialog).getByRole("button", { name: "검토 목록 다시 조회" }));
  await waitFor(() =>
    expect(within(opened.dialog).getByText(/검토 목록 조회를 완료했습니다/u)).toBeInTheDocument(),
  );
  // A later successful GET and a captured callback cannot re-send this POST.
  await act(async () => {
    await current.capture(opened.label)();
  });
  expect(requests).toHaveLength(1);
  expect(current.writes()).toHaveLength(1);
});
