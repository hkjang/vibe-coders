import { describe, expect, it, vi } from "vitest";

import { costGuardSchema } from "./cost-guard";
import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

describe("확인된 비용 보호 API 응답", () => {
  const reads = [endpoints.domains.governance.costGuard.get, endpoints.domains.routing.costGuard];
  it("조회 두 곳과 저장 응답이 같은 필수 schema를 사용한다", () => {
    for (const endpoint of [...reads, endpoints.domains.governance.costGuard.save]) {
      expect(endpoint.schema).toBe(costGuardSchema);
      expect(endpoint.schema.parse({ enabled: false, threshold_krw: 0 })).toEqual({
        enabled: false,
        threshold_krw: 0,
      });
      expect(endpoint.schema.parse({ enabled: true, threshold_krw: 0.125, stats: [] })).toEqual({
        enabled: true,
        threshold_krw: 0.125,
      });
      for (const body of [
        undefined,
        null,
        {},
        { enabled: false },
        { threshold_krw: 0 },
        { enabled: null, threshold_krw: 0 },
        { enabled: false, threshold_krw: null },
        { enabled: "false", threshold_krw: 0 },
        { enabled: true, threshold_krw: "1" },
        { enabled: true, threshold_krw: -1 },
        { enabled: true, threshold_krw: Infinity },
        { enabled: true, threshold_krw: NaN },
      ])
        expect(endpoint.schema.safeParse(body).success).toBe(false);
    }
  });
  it.each(reads)(
    "실제 client는 잘못된 조회 응답을 요청 ID와 계약 오류로 거부한다: $path",
    async (endpoint) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Request-ID": "req_cost_contract" },
        }),
      );
      const client = new ApiClient({ fetch });
      await expect(client.request(endpoint)).rejects.toMatchObject({
        kind: "contract",
        requestId: "req_cost_contract",
      });
    },
  );
});
