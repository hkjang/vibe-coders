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

async function open(h: ReturnType<typeof setupDomainDecisions>) {
  await h.settled();
  const trigger = within(h.section()).getByRole("button", { name: /결정 근거 보기/ });
  await h.user.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog") };
}

describe("도메인 결정 근거의 조회 전용 경계", () => {
  it("읽기 전용 feature와 routing:read만으로 조회·상세를 사용할 수 있다", async () => {
    const h = setupDomainDecisions({ auth: { scopes: ["routing:read"], readOnly: true } });
    const { dialog } = await open(h);
    expect(dialog).toHaveTextContent(decisionSignal.reason);
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("raw capability가 없으면 결정 GET과 결정 캐시가 생기지 않는다", () => {
    const h = setupDomainDecisions({ auth: { raw: false } });
    expect(h.section()).toHaveTextContent("프롬프트 원문 조회 권한");
    expect(h.decisionCalls()).toHaveLength(0);
    expect(h.queries()).toHaveLength(0);
  });

  it.each([
    [null, "근거 조회를 확인하지 못했습니다.", "현재 응답에 근거 기록이 없습니다."],
    [[], "현재 응답에 근거 기록이 없습니다.", "근거 조회를 확인하지 못했습니다."],
  ] as const)("근거 %j를 다른 의미로 바꾸지 않는다", async (signals, shown, absent) => {
    const h = setupDomainDecisions({
      decision: () => jsonResponse({ decisions: [decisionRow], signals: { [decisionRow.id]: signals } }),
    });
    const { dialog } = await open(h);
    expect(dialog).toHaveTextContent(shown);
    expect(dialog).not.toHaveTextContent(absent);
  });

  it("범위 밖 점수를 퍼센트로 바꾸지 않고 도구·플래그의 기록 한계를 설명한다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    const section = h.section();
    const { dialog } = await open(h);
    expect(dialog).toHaveTextContent("1.12");
    expect(dialog).not.toHaveTextContent("112%");
    expect(dialog).toHaveTextContent("후보 도구가 실제 호출되었다는 뜻은 아닙니다");
    expect(dialog).toHaveTextContent("실제 실행 결과를 확정할 수 없습니다");
    expect(dialog).toHaveTextContent("표시된 순서가 실행 순서");
    expect(section).toHaveTextContent("마지막 목록 수신(한국 시각)");
  });

  it("25개 근거와 후보 도구는 처음 20개만 렌더하고 GET 없이 다음 페이지로 이동한다", async () => {
    const signals = Array.from({ length: 25 }, (_, i) => ({
      ...decisionSignal,
      id: `sig_${i}`,
      reason: `합성 근거 순번 ${i + 1}`,
    }));
    const tools = Array.from({ length: 25 }, (_, i) => `합성 후보 도구 ${i + 1}`);
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({
          decisions: [{ ...decisionRow, tool_names: tools }],
          signals: { [decisionRow.id]: signals },
        }),
    });
    const { dialog } = await open(h);
    expect(dialog).toHaveTextContent("함께 조회된 근거 25건");
    expect(dialog).not.toHaveTextContent("합성 근거 순번 21");
    expect(dialog).not.toHaveTextContent("합성 후보 도구 21");
    const before = h.decisionCalls().length;
    await h.user.click(within(dialog).getByRole("button", { name: "다음 근거 페이지" }));
    expect(dialog).toHaveTextContent("합성 근거 순번 21");
    expect(within(dialog).getByRole("heading", { name: "함께 조회된 결정 근거" })).toHaveFocus();
    await h.user.click(within(dialog).getByRole("button", { name: "다음 도구 페이지" }));
    expect(dialog).toHaveTextContent("합성 후보 도구 21");
    expect(h.decisionCalls()).toHaveLength(before);
  });

  it.each(["", "__proto__", "constructor"])("정확한 결정 ID %j에 연결된 근거만 안전하게 연다", async (id) => {
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({
          decisions: [{ ...decisionRow, id }],
          signals: Object.fromEntries([[id, [{ ...decisionSignal, decision_id: id }]]]),
        }),
    });
    const { dialog } = await open(h);
    expect(dialog).toHaveTextContent(decisionSignal.reason);
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("51건 응답을 조용히 잘라서 정상 최대 50건처럼 표시하지 않는다", async () => {
    const decisions = Array.from({ length: 51 }, (_, i) => ({ ...decisionRow, id: `dd_${i}` }));
    const h = setupDomainDecisions({
      decision: () =>
        jsonResponse({ decisions, signals: Object.fromEntries(decisions.map((item) => [item.id, []])) }),
    });
    await h.settled("error");
    expect(h.actualQuery().state.data).toBeUndefined();
    expect(h.section()).toHaveTextContent("최신 결정 목록을 확인하지 못했습니다.");
    expect(h.section()).not.toHaveTextContent(decisionRow.reason);
  });
});

describe("도메인 결정의 URL·조회·상세 수명", () => {
  it("요청 ID URL을 복원하고 명시적 적용 전에는 입력을 조회나 URL로 보내지 않는다", async () => {
    const h = setupDomainDecisions({ search: "?window=30d&route=public-sql-route&request_id=req_link" });
    await h.settled();
    const input = within(h.section()).getByRole("textbox", { name: "요청 ID" });
    expect(input).toHaveValue("req_link");
    expect(h.decisionCalls()[0]?.query.request_id).toBe("req_link");
    const siblingCalls = h.calls.filter((call) => !call.path.endsWith("domain-decisions")).length;
    await h.user.clear(input);
    await h.user.type(input, "req_draft");
    expect(h.search()).toContain("request_id=req_link");
    expect(h.decisionCalls()).toHaveLength(1);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 로그 조회" }));
    await h.settled();
    expect(h.search()).toContain("request_id=req_draft");
    expect(h.search()).toContain("window=30d");
    expect(h.search()).toContain("route=public-sql-route");
    expect(h.calls.filter((call) => !call.path.endsWith("domain-decisions"))).toHaveLength(siblingCalls);
  });

  it("URL A→B→A 복원 시 예전 미적용 초안이 되살아나지 않는다", async () => {
    const h = setupDomainDecisions({ search: "?request_id=req_A" });
    await h.settled();
    const input = within(h.section()).getByRole("textbox", { name: "요청 ID" });
    await h.user.clear(input);
    await h.user.type(input, "req_unapplied");
    h.navigate("?request_id=req_B");
    await h.settled();
    expect(input).toHaveValue("req_B");
    h.navigate("?request_id=req_A");
    await h.settled();
    expect(input).toHaveValue("req_A");
    expect(h.queries()).toHaveLength(1);
  });

  it("Go 공백은 제거하고 FEFF는 보존한 정확한 요청 ID를 적용한다", async () => {
    const h = setupDomainDecisions();
    await h.settled();
    const input = within(h.section()).getByRole("textbox", { name: "요청 ID" });
    await h.user.click(input);
    await h.user.paste("\u0085\ufeffreq_public\ufeff\u0085");
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 로그 조회" }));
    await h.settled();
    expect(h.decisionCalls().at(-1)?.query.request_id).toBe("\ufeffreq_public\ufeff");
    expect(new URLSearchParams(h.search()).get("request_id")).toBe("\ufeffreq_public\ufeff");
  });

  it("설정된 접두사의 자격 증명 입력을 URL·GET에 반영하지 않는다", async () => {
    const h = setupDomainDecisions({ auth: { prefixes: ["publickey_"] } });
    await h.settled();
    const secret = `publickey_${"SYNTHETIC_ONLY_".repeat(4)}`;
    await h.user.click(within(h.section()).getByRole("textbox", { name: "요청 ID" }));
    await h.user.paste(secret);
    await h.user.click(within(h.section()).getByRole("button", { name: "결정 로그 조회" }));
    expect(within(h.section()).getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    expect(h.search()).not.toContain(secret);
    expect(h.decisionCalls()).toHaveLength(1);
  });

  it("재조회 중 상세 DOM·키보드 포커스·원래 근거가 유지되고 닫으면 유효한 행으로 복귀한다", async () => {
    const h = setupDomainDecisions();
    const { trigger, dialog } = await open(h);
    expect(within(dialog).getByRole("heading", { name: "선택한 결정 기록" })).toHaveFocus();
    const held = deferred<Response>();
    h.responses.decision = () => held.promise;
    const refresh = within(dialog).getByRole("button", { name: "결정 목록 다시 조회" });
    await h.user.click(refresh);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(refresh).toHaveFocus();
    const fresh = { ...decisionRow, reason: "새 조회의 결정 사유" };
    await act(async () =>
      held.resolve(
        jsonResponse({
          decisions: [fresh],
          signals: { [fresh.id]: [{ ...decisionSignal, reason: "새 조회의 근거" }] },
        }),
      ),
    );
    await h.settled();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(decisionRow.reason);
    expect(dialog).toHaveTextContent(decisionSignal.reason);
    expect(dialog).not.toHaveTextContent("새 조회의 근거");
    expect(dialog).toHaveTextContent("이전 조회에서 선택한 기록입니다.");
    await h.user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(h.section()).toHaveTextContent("새 조회의 결정 사유");
  });

  it("목록에서 선택 행이 사라진 뒤 상세를 닫으면 결정 영역 제목으로 복귀한다", async () => {
    const h = setupDomainDecisions();
    const { dialog } = await open(h);
    h.responses.decision = () => jsonResponse({ decisions: [], signals: {} });
    await h.user.click(within(dialog).getByRole("button", { name: "결정 목록 다시 조회" }));
    await h.settled();
    await h.user.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "도메인 결정 로그" }).firstElementChild).toHaveFocus(),
    );
  });

  it("회수된 raw 권한의 늦은 GET은 중단되며 복원한 새 조회나 캐시를 오염시키지 않는다", async () => {
    const held = deferred<Response>();
    const h = setupDomainDecisions({ decision: () => held.promise });
    const oldQuery = h.actualQuery();
    const oldCall = h.decisionCalls()[0];
    h.update({ raw: false });
    expect(oldCall?.signal?.aborted).toBe(true);
    expect(h.queries()).toHaveLength(0);
    h.responses.decision = () => jsonResponse(decisionReport());
    h.update({ raw: true });
    await h.settled();
    expect(h.actualQuery()).not.toBe(oldQuery);
    await act(async () =>
      held.resolve(
        jsonResponse({
          decisions: [{ ...decisionRow, reason: "종료된 조회의 합성 사유" }],
          signals: { [decisionRow.id]: [] },
        }),
      ),
    );
    expect(document.body).not.toHaveTextContent("종료된 조회의 합성 사유");
    expect(JSON.stringify(h.queries().map((query) => query.state))).not.toContain("종료된 조회의 합성 사유");
    expect(h.queries()).toHaveLength(1);
  });

  it("주체 A→B→A는 이전 상세·캐시를 폐기하고 새 조회 수명으로 돌아온다", async () => {
    const h = setupDomainDecisions();
    const { dialog } = await open(h);
    const oldQuery = h.actualQuery();
    h.update({ user: "public-reader-B" });
    await h.settled();
    expect(dialog).not.toBeInTheDocument();
    h.update({ user: "public-decision-reader" });
    await h.settled();
    expect(h.actualQuery()).not.toBe(oldQuery);
    expect(h.queries()).toHaveLength(1);
  });

  it("잘못된 JSON의 원문·cause는 결정 오류 캐시에 남지 않는다", async () => {
    const canary = "PUBLIC-MALFORMED-JSON-CANARY";
    const h = setupDomainDecisions({
      decision: () =>
        new Response(`{"query_text":"${canary}"`, { headers: { "Content-Type": "application/json" } }),
    });
    await h.settled("error");
    const error = h.actualQuery().state.error as Error;
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(error.cause).toBeUndefined();
  });
});
