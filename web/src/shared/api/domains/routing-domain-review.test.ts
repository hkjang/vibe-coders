import { QueryClient } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { ApiClient, type ApiRequestOptions } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import {
  domainReviewAckMatches,
  domainReviewAddressableID,
  domainReviewDecisionEndpoint,
  routingDomainReviewAckSchema,
  routingDomainReviewEndpoints,
  routingDomainReviewItemSchema,
  routingDomainReviewQuerySchema,
  routingDomainReviewReportSchema,
  type DomainReviewAction,
} from "./routing-domain-review";

const item = {
  id: "review_exact_a",
  decision_id: "decision_exact_a",
  suggested_route: "coding",
  current_route: "general",
  reason: "공개 합성 분류 검토 근거",
  status: "pending",
  created_at: "2026-10-01T00:00:00Z",
  reviewed_at: "",
};
const transportItem = { ...item, query_text: "SYNTHETIC_RAW_QUERY_NOT_FOR_CACHE" };
const report = { items: [item] };
const query = { status: "pending", limit: 50 } as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function clientFor(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(body));
  const client = new ApiClient({
    fetch,
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
  });
  return { client, fetch };
}

describe("도메인 검토의 엄격한 수신 목록 계약", () => {
  it("독립된 엄격한 DTO를 기존 GET/POST 경로에 등록한다", () => {
    expect(endpoints.domains.routingDomainReview).toBe(routingDomainReviewEndpoints);
    expect(routingDomainReviewEndpoints.queue.method).toBe("GET");
    expect(routingDomainReviewEndpoints.queue.path).toBe(endpoints.domains.routing.domain.review.path);
    expect(routingDomainReviewEndpoints.queue.schema).toBe(routingDomainReviewReportSchema);
    expect(routingDomainReviewEndpoints.decide.method).toBe("POST");
    expect(routingDomainReviewEndpoints.decide.path).toBe(endpoints.domains.routing.domain.reviewAction.path);
    expect(routingDomainReviewEndpoints.decide.schema).toBe(routingDomainReviewAckSchema);
    expect(routingDomainReviewEndpoints.decide.querySchema).toBeUndefined();
    expectTypeOf<
      ApiRequestOptions<typeof routingDomainReviewEndpoints.decide>["body"]
    >().toEqualTypeOf<undefined>();
  });

  it("실제 전송 문자열에서 query_text와 알 수 없는 필드를 제거한다", () => {
    expect(
      routingDomainReviewReportSchema.parse({
        items: [{ ...transportItem, extra: { query_text: "SYNTHETIC_NESTED_RAW" } }],
        query_text: "SYNTHETIC_TOP_LEVEL_RAW",
        extra: "SYNTHETIC_EXTRA",
      }),
    ).toEqual(report);
    expect(Object.keys(routingDomainReviewItemSchema.parse(transportItem))).toEqual(Object.keys(item));
  });

  it("서버 전송 원문을 ApiClient 반환 및 성공 캐시 저장 전에 제거한다", async () => {
    const { client, fetch } = clientFor({ items: [transportItem], extra: "SYNTHETIC_EXTRA" });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["strict-domain-review", query] as const;
    try {
      const data = await cache.fetchQuery({
        queryKey,
        queryFn: () => client.request(routingDomainReviewEndpoints.queue, { query }),
      });
      expect(data).toEqual(report);
      expect(cache.getQueryState(queryKey)?.status).toBe("success");
      expect(cache.getQueryData(queryKey)).toEqual(report);
      expect(JSON.stringify(cache.getQueryData(queryKey))).not.toContain("query_text");
      expect(JSON.stringify(cache.getQueryData(queryKey))).not.toContain(transportItem.query_text);
      expect(fetch).toHaveBeenCalledWith(
        "/admin/routing/domain-review?status=pending&limit=50",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      cache.clear();
    }
  });

  it("잘못된 전송 목록을 빈 목록이나 성공 캐시로 바꾸지 않는다", async () => {
    const { client } = clientFor({ items: [{ ...transportItem, reviewed_at: null }] });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["strict-domain-review", query] as const;
    try {
      await expect(
        cache.fetchQuery({
          queryKey,
          queryFn: () => client.request(routingDomainReviewEndpoints.queue, { query }),
        }),
      ).rejects.toMatchObject({ kind: "contract" });
      expect(cache.getQueryState(queryKey)?.status).toBe("error");
      expect(cache.getQueryData(queryKey)).toBeUndefined();
    } finally {
      cache.clear();
    }
  });

  it.each(Object.keys(item))("필수 표시 필드 %s 누락을 기본값으로 채우지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(transportItem).filter(([key]) => key !== field));
    expect(routingDomainReviewReportSchema.safeParse({ items: [missing] }).success).toBe(false);
  });

  it.each(Object.keys(item))("표시 필드 %s는 문자열 외 값을 강제 변환하지 않는다", (field) => {
    for (const invalid of [null, undefined, 0, false, [], {}]) {
      expect(
        routingDomainReviewReportSchema.safeParse({ items: [{ ...transportItem, [field]: invalid }] })
          .success,
      ).toBe(false);
    }
  });

  it.each([null, [], {}, { items: null }, { items: {} }, { items: [null] }, { items: ["row"] }])(
    "유효하지 않은 목록 모양을 거부한다: %j",
    (raw) => {
      expect(routingDomainReviewReportSchema.safeParse(raw).success).toBe(false);
    },
  );

  it("빈 목록과 서버 상한 200개는 허용하고 초과 응답은 거부한다", () => {
    expect(routingDomainReviewReportSchema.parse({ items: [] })).toEqual({ items: [] });
    const items = Array.from({ length: 200 }, (_, index) => ({ ...transportItem, id: `review_${index}` }));
    expect(routingDomainReviewReportSchema.parse({ items }).items).toHaveLength(200);
    expect(
      routingDomainReviewReportSchema.safeParse({ items: [...items, { ...transportItem, id: "extra" }] })
        .success,
    ).toBe(false);
  });

  it("중복 ID의 서로 다른 검토 내용을 하나의 선택 대상으로 만들지 않는다", () => {
    expect(
      routingDomainReviewReportSchema.safeParse({
        items: [transportItem, { ...transportItem, suggested_route: "different" }],
      }).success,
    ).toBe(false);
    expect(
      routingDomainReviewReportSchema.parse({
        items: [transportItem, { ...transportItem, id: ` ${item.id} ` }],
      }).items,
    ).toHaveLength(2);
  });

  it("알 수 없는 상태와 빈 검토 일시 및 모든 수신 문자열을 그대로 보존한다", () => {
    const raw = {
      ...transportItem,
      id: " \u0085공개 검토\ufeff ",
      decision_id: " decision_a ",
      suggested_route: " FUTURE_ROUTE ",
      current_route: "",
      reason: " \n공개 합성 근거\n ",
      status: "future_status",
      created_at: "future date representation",
      reviewed_at: "",
    };
    const { query_text, ...expected } = raw;
    expect(query_text).toBe(transportItem.query_text);
    expect(routingDomainReviewReportSchema.parse({ items: [raw] })).toEqual({ items: [expected] });
  });

  it.each(["pending", "approved", "rejected"])("상태 %s와 화면의 limit 50만 조회한다", (status) => {
    expect(routingDomainReviewQuerySchema.parse({ status, limit: 50 })).toEqual({ status, limit: 50 });
    expect(
      routingDomainReviewQuerySchema.parse({ status, limit: 50, window: "7d", route: "coding" }),
    ).toEqual({ status, limit: 50 });
  });

  it.each([
    {},
    { status: "pending" },
    { limit: 50 },
    { status: "future_status", limit: 50 },
    { status: " pending ", limit: 50 },
    { status: null, limit: 50 },
    { status: "pending", limit: "50" },
    { status: "pending", limit: 0 },
    { status: "pending", limit: 200 },
    { status: "pending", limit: null },
  ])("조회 조건을 추정하거나 기본값으로 보정하지 않는다: %j", (raw) => {
    expect(routingDomainReviewQuerySchema.safeParse(raw).success).toBe(false);
  });
});

const addressableIDs = [
  ["review_exact_a", "review_exact_a"],
  [" 검토 한글 ", "%20%EA%B2%80%ED%86%A0%20%ED%95%9C%EA%B8%80%20"],
  ["\ufeff", "%EF%BB%BF"],
  ["\u0085review\u0085", "%C2%85review%C2%85"],
  ["%2f", "%252f"],
  ["%2F", "%252F"],
  ["?#", "%3F%23"],
  ["\\", "%5C"],
  [".", "."],
  ["..", ".."],
  ["검토🧪", "%EA%B2%80%ED%86%A0%F0%9F%A7%AA"],
] as const;
const invalidIDs = [
  "",
  " ",
  "\u0085",
  "\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000",
  "/",
  "review/other",
  "review/approve",
  "review\u0000",
  "review\t",
  "review\n",
  "review\r",
  "review\u001f",
  "review\u007f",
  "\ud800",
  "\udfff",
  "review\ud800end",
  "\udc00\ud800",
  null,
  undefined,
  12,
];

describe("도메인 검토 대상의 정확한 경로와 요청 확인", () => {
  it.each(addressableIDs)("ID %j를 정규화 없이 같은 대상으로 인코딩한다", (id, encodedID) => {
    expect(domainReviewAddressableID(id)).toBe(true);
    for (const action of ["approve", "reject"] as const) {
      expect(domainReviewDecisionEndpoint(id, action).path).toBe(
        `/admin/routing/domain-review/${encodedID}%2F${action}`,
      );
      expect(
        domainReviewAckMatches({ id, status: action === "approve" ? "approved" : "rejected" }, id, action),
      ).toBe(true);
    }
  });

  it.each(invalidIDs)("주소로 확정할 수 없는 ID %j를 다른 대상으로 바꾸지 않고 거부한다", (id) => {
    expect(domainReviewAddressableID(id)).toBe(false);
    expect(() => domainReviewDecisionEndpoint(id as string, "approve")).toThrow();
    expect(domainReviewAckMatches({ id, status: "approved" }, id as string, "approve")).toBe(false);
  });

  it("모든 C0 제어 문자와 DEL을 ID 어디에서도 허용하지 않는다", () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(domainReviewAddressableID(`before${String.fromCharCode(code)}after`)).toBe(false);
    }
  });

  it.each(["approve", "reject"] as const)("%s를 기존 body 없는 POST로 보낸다", async (action) => {
    const ack = { id: item.id, status: action === "approve" ? "approved" : "rejected" };
    const { client, fetch } = clientFor(ack);
    const data = await client.request(domainReviewDecisionEndpoint(item.id, action));
    expect(data).toEqual(ack);
    expect(domainReviewAckMatches(data, item.id, action)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/admin/routing/domain-review/${item.id}%2F${action}`);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init).not.toHaveProperty("body");
  });

  it.each(["approve ", "approved", "APPROVE", "reject/approve", "", null, undefined, 1])(
    "런타임의 잘못된 동작 %j를 거부한다",
    (action) => {
      expect(() => domainReviewDecisionEndpoint(item.id, action as DomainReviewAction)).toThrow();
      expect(
        domainReviewAckMatches({ id: item.id, status: "approved" }, item.id, action as DomainReviewAction),
      ).toBe(false);
    },
  );

  it("ACK의 추가 필드를 제거하지만 ID는 그대로 보존한다", () => {
    expect(
      routingDomainReviewAckSchema.parse({ id: " review_exact_a ", status: "approved", extra: "extra" }),
    ).toEqual({ id: " review_exact_a ", status: "approved" });
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { id: item.id },
    { status: "approved" },
    { id: null, status: "approved" },
    { id: 12, status: "approved" },
    { id: item.id, status: null },
    { id: item.id, status: true },
    { id: item.id, status: "" },
    { id: item.id, status: "pending" },
    { id: item.id, status: "future_status" },
    { id: item.id, status: "approved " },
    { id: item.id, status: "Approved" },
  ])("알 수 없는 ACK를 성공으로 처리하지 않는다: %j", (ack) => {
    expect(routingDomainReviewAckSchema.safeParse(ack).success).toBe(false);
    expect(domainReviewAckMatches(ack, item.id, "approve")).toBe(false);
    expect(domainReviewAckMatches(ack, item.id, "reject")).toBe(false);
  });

  it("다른 ID 또는 반대 동작의 ACK를 성공으로 처리하지 않는다", () => {
    for (const id of ["review_other", ` ${item.id}`, `${item.id} `, ""]) {
      expect(domainReviewAckMatches({ id, status: "approved" }, item.id, "approve")).toBe(false);
      expect(domainReviewAckMatches({ id, status: "rejected" }, item.id, "reject")).toBe(false);
    }
    expect(domainReviewAckMatches({ id: item.id, status: "rejected" }, item.id, "approve")).toBe(false);
    expect(domainReviewAckMatches({ id: item.id, status: "approved" }, item.id, "reject")).toBe(false);
  });

  it("형식이 잘못된 2xx ACK도 실제 클라이언트에서 계약 실패로 반환한다", async () => {
    const { client } = clientFor({ id: item.id, status: "pending" });
    await expect(client.request(domainReviewDecisionEndpoint(item.id, "approve"))).rejects.toMatchObject({
      kind: "contract",
    });
  });
});
