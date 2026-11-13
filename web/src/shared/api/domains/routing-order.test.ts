import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { routingOrderEndpoints } from "./routing-order";

function clientFor(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
  );
  const client = new ApiClient({
    fetch,
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
  });
  return { fetch, client };
}
describe("실제 API 클라이언트의 순서 조회 계약", () => {
  it("view=order를 검증해 실제 URL에 넣고 검토 기준을 보존한다", async () => {
    const snapshot = { rules: [], revision: "a".repeat(64), ambiguous_ties: false };
    const { client, fetch } = clientFor(snapshot);
    expect(await client.request(routingOrderEndpoints.snapshot, { query: { view: "order" } })).toEqual(
      snapshot,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/admin/routing-rules?view=order");
  });
  it("기존 서버의 일반 목록을 검토 기준이 있는 목록으로 오인하지 않는다", async () => {
    const { client, fetch } = clientFor({ rules: [] });
    await expect(
      client.request(routingOrderEndpoints.snapshot, { query: { view: "order" } }),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("유실된 쓰기 응답을 자동 재전송하지 않는다", async () => {
    const { client, fetch } = clientFor({});
    fetch.mockRejectedValue(new TypeError("synthetic transport loss"));
    await expect(
      client.request(routingOrderEndpoints.save, {
        body: { order: ["a", "b"], expected_revision: "a".repeat(64), reason: "검토 완료" },
      }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
