import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  decisionRow,
  decisionSignal,
  deferred,
  jsonResponse,
  setupDomainDecisions,
} from "./domain-decisions-test-harness";

describe("도메인 결정 탐색 — 독립 캐시 경계 회귀", () => {
  it.each(["public-id", "__proto__", "constructor", "toString"])(
    "재조회 후에도 %s 결정의 근거를 자체 키로 보존한다",
    async (id) => {
      const report = (reason: string) => ({
        decisions: [{ ...decisionRow, id }],
        signals: Object.fromEntries([[id, [{ ...decisionSignal, decision_id: id, reason }]]]),
      });
      const h = setupDomainDecisions({
        decision: () => jsonResponse(report("공개 합성 첫 번째 근거")),
      });
      await h.settled();
      await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
      expect(screen.getByRole("dialog")).toHaveTextContent("공개 합성 첫 번째 근거");
      await h.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));

      h.responses.decision = () => jsonResponse(report("공개 합성 두 번째 근거"));
      await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
      await h.settled();
      expect(h.decisionCalls()).toHaveLength(2);
      const cached = h.actualQuery().state.data as { signals: Record<string, unknown> };
      // The HTTP adapter uses own-key identity. React Query's structural sharing
      // must not turn a literal __proto__ map key into an inherited value.
      expect(Object.hasOwn(cached.signals, id)).toBe(true);
      await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
      expect(screen.getByRole("dialog")).toHaveTextContent("공개 합성 두 번째 근거");
      expect(screen.getByRole("dialog")).not.toHaveTextContent("근거 조회를 확인하지 못했습니다.");
      expect(h.calls.every((call) => call.method === "GET")).toBe(true);
    },
  );

  it("403으로 숨긴 이전 결정과 열린 상세를 후속 503이 다시 표시하지 않는다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
    h.responses.decision = () =>
      jsonResponse({ error: { message: "public denied", type: "permission_error" } }, 403);
    await h.user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "결정 목록 다시 조회" }),
    );
    await h.settled("error");
    expect(h.actualQuery().state.error).toMatchObject({ status: 403 });
    expect(h.actualQuery().state.data).toBeUndefined();
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);

    h.responses.decision = () =>
      jsonResponse({ error: { message: "public unavailable", type: "server_error" } }, 503);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled("error");
    expect(h.actualQuery().state.error).toMatchObject({ status: 503 });
    expect(h.actualQuery().state.data).toBeUndefined();
    // A later availability error is not renewed raw-read authorization. The
    // selected snapshot and rows denied by the last 403 must remain hidden.
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);

    const fresh = { ...decisionRow, id: "fresh-public-decision", reason: "공개 새 결정 사유" };
    const freshSignal = {
      ...decisionSignal,
      id: "fresh-public-signal",
      decision_id: fresh.id,
      reason: "공개 새 근거",
    };
    h.responses.decision = () => jsonResponse({ decisions: [fresh], signals: { [fresh.id]: [freshSignal] } });
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled();
    expect(Boolean(screen.queryByRole("dialog"))).toBe(false);
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
    await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent(freshSignal.reason);
  });

  it("거부 뒤 진행 중인 재조회 취소가 이전 성공 캐시를 복구하지 않는다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    h.responses.decision = () =>
      jsonResponse({ error: { message: "public denied", type: "permission_error" } }, 403);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled("error");
    expect(h.actualQuery().state.data).toBeUndefined();
    const held = deferred<Response>();
    h.responses.decision = () => held.promise;
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 목록 다시 조회" }));
    const query = h.actualQuery();
    await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
    await act(async () => {
      await h.view.client.cancelQueries({ queryKey: query.queryKey, exact: true }, { revert: true });
    });
    expect(query.state.data).toBeUndefined();
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
    await act(async () => {
      held.resolve(jsonResponse({ decisions: [{ ...decisionRow }], signals: { [decisionRow.id]: [] } }));
      await held.promise;
    });
    expect(query.state.data).toBeUndefined();
    expect(document.body.textContent?.includes(decisionRow.reason)).toBe(false);
  });

  it.each(["request_id", "route"])(
    "초기 주소의 사용자 지정 접두사 비밀 %s를 결정 조회나 캐시에 전달하지 않는다",
    async (parameter) => {
      const secret = `synthetic_custom_${"PUBLIC_ONLY_".repeat(4)}`;
      const h = setupDomainDecisions({
        auth: { prefixes: ["synthetic_custom_"] },
        search: `?${parameter}=${encodeURIComponent(secret)}`,
      });
      await h.settled();
      expect(h.decisionCalls().length).toBeGreaterThan(0);
      expect(h.decisionCalls().some((call) => JSON.stringify(call.query).includes(secret))).toBe(false);
      expect(h.queries().some((query) => JSON.stringify(query.queryKey).includes(secret))).toBe(false);
      expect(h.search().includes(secret)).toBe(false);
    },
  );
});
