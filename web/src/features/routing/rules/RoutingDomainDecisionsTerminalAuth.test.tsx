import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { subscribeToLogout, tokenStore } from "@/shared/auth/token-store";
import {
  decisionReport,
  decisionRow,
  decisionSignal,
  deferred,
  jsonResponse,
  setupDomainDecisions,
} from "./domain-decisions-test-harness";

describe("도메인 결정 탐색 — 실제 클라이언트의 최종 인증 거부", () => {
  it("갱신 토큰 없는 401은 전역 권한 변경 없이 이전 원문 캐시와 열린 상세를 폐기한다", async () => {
    // A still-mounted authenticated screen can receive a terminal 401 without
    // any global logout event: the real ApiClient has no refresh token to use.
    tokenStore.saveTokens({ access_token: "synthetic-public-access-only", refresh_token: "" });
    const epoch = tokenStore.getSessionEpoch();
    const onLogout = vi.fn();
    const stopLogout = subscribeToLogout(onLogout);
    try {
      const h = setupDomainDecisions();
      await h.settled();
      await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
      expect(Boolean(screen.queryByRole("dialog"))).toBe(true);
      expect(document.body.textContent?.includes(decisionRow.reason)).toBe(true);
      expect(h.actualQuery().state.data !== undefined).toBe(true);

      h.responses.decision = () =>
        jsonResponse({ error: { message: "synthetic terminal unauthorized", type: "auth_error" } }, 401);
      await h.user.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "결정 목록 다시 조회" }),
      );
      await h.settled("error");

      // The synthetic fetch is behind the actual ApiClient error/refresh path.
      // No fake auth update, logout, session advance or hidden retry can account
      // for retiring this feature's sensitive data after the terminal denial.
      expect(h.actualQuery().state.error).toMatchObject({ kind: "auth", status: 401 });
      expect(tokenStore.getSessionEpoch()).toBe(epoch);
      expect(onLogout).toHaveBeenCalledTimes(0);
      expect(h.decisionCalls()).toHaveLength(2);
      expect(h.calls.every((call) => call.method === "GET")).toBe(true);
      expect.soft(h.actualQuery().state.data !== undefined).toBe(false);
      expect.soft(Boolean(screen.queryByRole("dialog"))).toBe(false);
      expect.soft(document.body.textContent?.includes(decisionRow.reason)).toBe(false);

      h.responses.decision = () =>
        jsonResponse({ error: { message: "synthetic unavailable", type: "server_error" } }, 503);
      await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
      await h.settled("error");
      expect(h.actualQuery().state.error).toMatchObject({ status: 503 });
      expect(h.actualQuery().state.data !== undefined).toBe(false);
      expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
      expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
      expect(h.decisionCalls()).toHaveLength(3);

      const fresh = { ...decisionRow, id: "fresh-public-auth-decision", reason: "공개 새 인증 후 결정" };
      const signal = { ...decisionSignal, decision_id: fresh.id, reason: "공개 새 인증 후 근거" };
      h.responses.decision = () => jsonResponse({ decisions: [fresh], signals: { [fresh.id]: [signal] } });
      await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
      await h.settled();
      expect(h.decisionCalls()).toHaveLength(4);
      expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
      expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
      await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
      expect(screen.getByRole("dialog")).toHaveTextContent(signal.reason);
      expect(tokenStore.getSessionEpoch()).toBe(epoch);
      expect(onLogout).toHaveBeenCalledTimes(0);
    } finally {
      stopLogout();
    }
  });

  it("401 후 복구 조회를 취소해도 이전 성공 스냅샷이나 늦은 200을 복원하지 않는다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    h.responses.decision = () =>
      jsonResponse({ error: { message: "synthetic terminal unauthorized", type: "auth_error" } }, 401);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled("error");
    expect(h.actualQuery().state.error).toMatchObject({ kind: "auth", status: 401 });
    expect(h.actualQuery().state.data !== undefined).toBe(false);

    const held = deferred<Response>();
    h.responses.decision = () => held.promise;
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    const query = h.actualQuery();
    await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
    await act(async () => {
      await h.view.client.cancelQueries({ queryKey: query.queryKey, exact: true }, { revert: true });
    });
    expect(h.decisionCalls()[2]?.signal?.aborted).toBe(true);
    expect(query.state.data !== undefined).toBe(false);
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
    await act(async () => {
      held.resolve(jsonResponse(decisionReport()));
      await held.promise;
    });
    expect(query.state.data !== undefined).toBe(false);
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(h.decisionCalls()).toHaveLength(3);
  });

  it("취소된 이전 요청의 늦은 401은 새 성공 캐시와 새 상세를 거부하지 않는다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    const held = deferred<Response>();
    h.responses.decision = () => held.promise;
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    const query = h.actualQuery();
    await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
    await act(async () => {
      await h.view.client.cancelQueries({ queryKey: query.queryKey, exact: true }, { revert: true });
    });
    expect(h.decisionCalls()[1]?.signal?.aborted).toBe(true);

    const fresh = { ...decisionRow, id: "fresh-public-after-cancel", reason: "공개 취소 후 새 결정" };
    const signal = { ...decisionSignal, decision_id: fresh.id, reason: "공개 취소 후 새 근거" };
    h.responses.decision = () => jsonResponse({ decisions: [fresh], signals: { [fresh.id]: [signal] } });
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled();
    const accepted = h.actualQuery().state.data;
    await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent(signal.reason);

    await act(async () => {
      held.resolve(
        jsonResponse({ error: { message: "synthetic stale unauthorized", type: "auth_error" } }, 401),
      );
      await held.promise;
    });
    expect(h.actualQuery().state.status).toBe("success");
    expect(h.actualQuery().state.data === accepted).toBe(true);
    expect(screen.getByRole("dialog")).toHaveTextContent(signal.reason);
    expect(h.decisionCalls()).toHaveLength(3);
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });
});
