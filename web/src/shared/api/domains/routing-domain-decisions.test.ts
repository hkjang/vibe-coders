import { QueryClient } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiClient, type ApiRequestOptions } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  routingDomainDecisionEndpoints,
  routingDomainDecisionReportSchema,
  routingDomainDecisionSchema,
  routingDomainDecisionsQuerySchema,
  routingDomainSignalSchema,
} from "./routing-domain-decisions";

const decision = {
  id: "decision_한글 %2F ?#",
  request_id: "request_한글 %2F ?#",
  route: "unknown-route",
  confidence: 1.25,
  tool_names: ["synthetic/tool"],
  evidence_score: -2.5,
  evidence_count: -1,
  fallback_used: false,
  blocked_by_governance: true,
  reason: "공개 합성 결정 근거",
  created_at: "2026-10-08T00:00:00.123456789Z",
};
const signal = {
  id: "signal_exact",
  decision_id: decision.id,
  source: "future-source",
  route: "unknown-signal-route",
  score: -9.5,
  reason: "공개 합성 도구 근거",
  created_at: "2026-10-08T00:00:00.987654321Z",
};
const report = { decisions: [decision], signals: { [decision.id]: [signal] } };
const query = { window: "7d", limit: 50 } as const;

function clientFor(body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = new ApiClient({
    fetch,
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
  });
  return { client, fetch };
}

describe("도메인 결정 조회의 엄격한 메타데이터 계약", () => {
  it("기존 GET에만 전용 계약을 등록하고 요청 본문을 허용하지 않는다", () => {
    expect(endpoints.domains.routingDomainDecisions).toBe(routingDomainDecisionEndpoints);
    expect(routingDomainDecisionEndpoints.report.method).toBe("GET");
    expect(routingDomainDecisionEndpoints.report.path).toBe(endpoints.domains.routing.domain.decisions.path);
    expectTypeOf<
      ApiRequestOptions<typeof routingDomainDecisionEndpoints.report>["body"]
    >().toEqualTypeOf<undefined>();
  });

  it("원래 문자열·알 수 없는 분류·부호 있는 수치와 나노초 시각을 보존한다", () => {
    expect(routingDomainDecisionReportSchema.parse(report)).toEqual(report);
    expect(Object.keys(routingDomainDecisionSchema.parse(decision))).toHaveLength(11);
    expect(Object.keys(routingDomainSignalSchema.parse(signal))).toHaveLength(7);
  });

  it("수신 원문과 미사용 식별자 및 다른 결정의 신호를 성공 캐시 전에 제외한다", async () => {
    const canary = "SYNTHETIC_UNUSED_RAW_CANARY";
    const input = {
      query_text: canary,
      decisions: [{ ...decision, query_text: canary, query_hash: canary, user_id: canary, team_id: canary }],
      signals: {
        [decision.id]: [{ ...signal, query_text: canary, extra: { raw: canary } }],
        unselected: { query_text: canary },
      },
    };
    const { client } = clientFor(input);
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const result = await cache.fetchQuery({
        queryKey: ["domain-decision-contract"],
        queryFn: () => client.request(routingDomainDecisionEndpoints.report, { query }),
      });
      expect(result).toEqual(report);
      expect(JSON.stringify(cache.getQueryData(["domain-decision-contract"]))).not.toContain(canary);
      expect(result.decisions[0]?.reason).toBe(decision.reason);
      expect(result.signals[decision.id]?.[0]?.reason).toBe(signal.reason);
    } finally {
      cache.clear();
    }
  });

  it.each(["", "__proto__", "constructor", "toString", "한글 / %2F ?#"])(
    "신호 키 %s를 정확한 자체 속성으로 다룬다",
    (id) => {
      const input = JSON.parse(
        JSON.stringify({
          decisions: [{ ...decision, id }],
          signals: Object.fromEntries([[id, [{ ...signal, decision_id: id }]]]),
        }),
      );
      const parsed = routingDomainDecisionReportSchema.parse(input);
      expect(Object.hasOwn(parsed.signals, id)).toBe(true);
      expect(parsed.signals[id]?.[0]?.decision_id).toBe(id);
      expect(Object.keys(parsed.signals)).toEqual([id]);
    },
  );

  it.each([[], null])("빈 신호와 미확인 신호 %s를 구분한다", (value) => {
    const parsed = routingDomainDecisionReportSchema.parse({
      decisions: [decision],
      signals: { [decision.id]: value },
    });
    expect(parsed.signals[decision.id]).toEqual(value);
  });

  it("정상 빈 결정 목록을 보존하며 불필요한 신호는 남기지 않는다", () => {
    expect(routingDomainDecisionReportSchema.parse({ decisions: [], signals: { unused: "raw" } })).toEqual({
      decisions: [],
      signals: {},
    });
  });

  it.each(Object.keys(decision))("결정 필수 필드 %s를 기본값으로 채우지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(decision).filter(([key]) => key !== field));
    expect(routingDomainDecisionReportSchema.safeParse({ ...report, decisions: [missing] }).success).toBe(
      false,
    );
  });

  it.each(Object.keys(signal))("신호 필수 필드 %s를 기본값으로 채우지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(signal).filter(([key]) => key !== field));
    expect(
      routingDomainDecisionReportSchema.safeParse({ ...report, signals: { [decision.id]: [missing] } })
        .success,
    ).toBe(false);
  });

  it.each([
    { ...report, signals: {} },
    { ...report, signals: null },
    { ...report, signals: [] },
    { ...report, signals: { [decision.id]: {} } },
    { ...report, signals: { [decision.id]: [{ ...signal, decision_id: "another" }] } },
    { ...report, signals: { [decision.id]: [signal, signal] } },
    { ...report, decisions: [decision, decision] },
    { ...report, decisions: [{ ...decision, evidence_count: 1.5 }] },
    { ...report, decisions: [{ ...decision, evidence_count: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...report, decisions: [{ ...decision, confidence: "0.5" }] },
    { ...report, decisions: [{ ...decision, confidence: Infinity }] },
    { ...report, decisions: [{ ...decision, tool_names: null }] },
    { ...report, decisions: [{ ...decision, fallback_used: "false" }] },
    { ...report, signals: { [decision.id]: [{ ...signal, score: NaN }] } },
  ])("잘못된 목록·연결·형식을 빈 결과로 바꾸지 않는다 %#", (input) => {
    expect(routingDomainDecisionReportSchema.safeParse(input).success).toBe(false);
  });

  it("200개를 초과하는 결정 목록을 거부한다", () => {
    const decisions = Array.from({ length: 201 }, (_, index) => ({ ...decision, id: `d_${index}` }));
    const signals = Object.fromEntries(decisions.map(({ id }) => [id, []]));
    expect(routingDomainDecisionReportSchema.safeParse({ decisions, signals }).success).toBe(false);
  });

  it("요청 ID·라우트를 URL에 인코딩하고 GET만 한 번 실행한다", async () => {
    const { client, fetch } = clientFor(report);
    const submitted = { ...query, request_id: decision.request_id, route: "한글 /?#+%2f" };
    await client.request(routingDomainDecisionEndpoints.report, { query: submitted });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("request_id")).toBe(submitted.request_id);
    expect(params.get("route")).toBe(submitted.route);
    expect(params.get("limit")).toBe("50");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it.each([
    { ...query, status: "pending" },
    { ...query, team_id: "team" },
    { ...query, page: 2 },
    { ...query, limit: 200 },
    { ...query, window: "garbage" },
    { ...query, request_id: 1 },
  ])("지원하지 않는 화면 조회 조건을 차단한다 %#", (input) => {
    expect(routingDomainDecisionsQuerySchema.safeParse(input).success).toBe(false);
  });
});
