import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  decisionReport,
  decisionRow,
  decisionSignal,
  deferred,
  jsonResponse,
  setupDomainDecisions,
} from "./domain-decisions-test-harness";

describe("도메인 결정 탐색 — 기존 동작 양성 대조군", () => {
  it("실제 학습 화면이 성공 응답의 결정 행과 기존 조회 조건을 표시하고 쓰기를 하지 않는다", async () => {
    const h = setupDomainDecisions({ search: "?window=30d&route=public-sql-route" });
    await h.settled();
    expect(h.section()).toHaveTextContent(decisionRow.reason);
    expect(h.section()).toHaveTextContent(decisionRow.route);
    expect(h.decisionCalls()).toHaveLength(1);
    expect(h.decisionCalls()[0]?.query).toMatchObject({ window: "30d", route: "public-sql-route" });
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("실제 HTTP 403을 원문 조회 권한 거부로 표시한다", async () => {
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({ error: { message: "public synthetic denial", type: "permission_error" } }, 403),
    });
    await h.settled("error");
    expect(h.actualQuery().state.error).toMatchObject({ status: 403, kind: "permission" });
    expect(h.section()).toHaveTextContent("프롬프트 원문 조회 권한");
    expect(h.section()).not.toHaveTextContent("결정 로그가 없습니다.");
  });

  it("성공한 실제 빈 응답은 빈 목록으로 표시한다", async () => {
    const h = setupDomainDecisions({ decision: () => jsonResponse({ decisions: [], signals: {} }) });
    await h.settled();
    expect(h.section()).toHaveTextContent("결정 로그가 없습니다.");
  });

  it("routing:read가 없으면 실제 FeatureRoute가 화면과 모든 조회를 차단한다", () => {
    const h = setupDomainDecisions({ auth: { scopes: [] } });
    expect(screen.getByRole("heading", { name: "접근 권한이 없습니다." })).toBeVisible();
    expect(h.calls).toHaveLength(0);
    expect(h.queries()).toHaveLength(0);
  });
});

describe("도메인 결정 탐색 — 다음 마일스톤의 독립 RED 기준선", () => {
  it("응답을 기다리는 동안 성공한 빈 목록이라고 말하지 않는다", async () => {
    const held = deferred<Response>();
    const h = setupDomainDecisions({ decision: () => held.promise });
    expect(h.actualQuery().state.status).toBe("pending");
    const prematureEmpty = within(h.section()).queryByText("결정 로그가 없습니다.");
    await act(async () => held.resolve(jsonResponse(decisionReport())));
    await h.settled();
    expect(prematureEmpty).toBeNull();
  });

  it("실제 HTTP 503을 성공한 빈 목록으로 오표시하지 않는다", async () => {
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({ error: { message: "public synthetic outage", type: "server_error" } }, 503),
    });
    await h.settled("error");
    expect(h.actualQuery().state.error).toMatchObject({ status: 503 });
    expect(h.section()).not.toHaveTextContent("결정 로그가 없습니다.");
    expect(within(h.section()).getByRole("button", { name: /다시 조회/ })).toBeEnabled();
  });

  it("재조회 실패 시 남아 있는 이전 행을 최신 성공 자료처럼 표시하지 않고 경고한다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    h.responses.decision = () =>
      jsonResponse({ error: { message: "public refresh outage", type: "server_error" } }, 503);
    await h.user.click(screen.getByRole("button", { name: "새로고침" }));
    await h.settled("error");
    expect(h.section()).toHaveTextContent(decisionRow.reason);
    expect(within(h.section()).getByRole("alert")).toHaveTextContent(/이전|최신|실패|확인/);
  });

  it("서버가 반환한 25건 중 21번째 결정도 응답 내부 다음 페이지에서 접근할 수 있다", async () => {
    const decisions = Array.from({ length: 25 }, (_, index) => ({
      ...decisionRow,
      id: `dd_public_${index + 1}`,
      request_id: `req_public_${index + 1}`,
      reason: `공개 합성 결정 순번 ${index + 1}`,
    }));
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({ decisions, signals: Object.fromEntries(decisions.map((item) => [item.id, []])) }),
    });
    await h.settled();
    expect(h.actualQuery().state.data).toHaveProperty("decisions.length", 25);
    const before = h.decisionCalls().length;
    await h.user.click(within(h.section()).getByRole("button", { name: "다음 페이지" }));
    expect(h.section()).toHaveTextContent("공개 합성 결정 순번 21");
    expect(h.decisionCalls()).toHaveLength(before);
  });

  it("요청 ID를 명시적으로 적용하면 서버 지원 필터와 최대 50건 경계를 함께 전송한다", async () => {
    const h = setupDomainDecisions({ search: "?window=30d&route=public-sql-route" });
    await h.settled();
    const requestID = within(h.section()).getByRole("textbox", { name: "요청 ID" });
    await h.user.type(requestID, "req_public_exact");
    expect(h.decisionCalls()).toHaveLength(1);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 로그 조회" }));
    await waitFor(() =>
      expect(h.decisionCalls().at(-1)?.query).toEqual({
        window: "30d",
        route: "public-sql-route",
        request_id: "req_public_exact",
        limit: "50",
      }),
    );
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("행의 읽기 전용 근거 상세가 같은 결정 ID의 신호와 후보 도구를 보여 준다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    await h.user.click(within(h.section()).getByRole("button", { name: /결정 근거 보기/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(decisionSignal.reason);
    expect(dialog).toHaveTextContent(decisionRow.tool_names[0] ?? "");
    expect(dialog).toHaveTextContent(decisionRow.id);
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("결정 메타데이터에 포함된 자격 증명 형태를 화면이나 접근성 속성에 노출하지 않는다", async () => {
    const secret = `vc_sk_${"SYNTHETIC_ONLY_".repeat(4)}`;
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({
          decisions: [{ ...decisionRow, reason: `공개 이유 ${secret}` }],
          signals: { [decisionRow.id]: [] },
        }),
    });
    await h.settled();
    expect(h.section().outerHTML).not.toContain(secret);
  });

  it("서버의 미계약 원문 필드는 성공한 결정 쿼리 캐시에 들어오지 않는다", async () => {
    const canary = "PUBLIC-UNCONTRACTED-QUERY-TEXT-CANARY";
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({
          decisions: [{ ...decisionRow, query_text: canary }],
          signals: { [decisionRow.id]: [{ ...decisionSignal, query_text: canary }] },
          query_text: canary,
        }),
    });
    await h.settled();
    expect(JSON.stringify(h.actualQuery().state.data)).not.toContain(canary);
  });

  it("원문 조회 capability 회수는 이미 표시된 결정 행과 이전 결정 캐시를 제거한다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    expect(h.section()).toHaveTextContent(decisionRow.reason);
    h.update({ raw: false });
    expect(document.body).not.toHaveTextContent(decisionRow.reason);
    expect(h.queries().some((query) => query.state.data !== undefined)).toBe(false);
  });

  it("실제 HTTP 오류 응답의 미계약 원문을 결정 오류 캐시에 보관하지 않는다", async () => {
    const canary = "PUBLIC-HTTP-ERROR-QUERY-TEXT-CANARY";
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({ query_text: canary, error: { message: "public outage", type: "server_error" } }, 503),
    });
    await h.settled("error");
    expect(JSON.stringify(h.actualQuery().state.error)).not.toContain(canary);
  });
});
