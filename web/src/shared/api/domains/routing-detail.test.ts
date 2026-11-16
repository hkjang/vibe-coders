import { expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { routingEndpoints } from "./routing";
function setup(body: unknown = { rules: [] }) {
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
  return { client, fetch };
}
it("실제 상세 클라이언트는 ID를 검증하고 쿼리로 안전하게 인코딩한다", async () => {
  const { client, fetch } = setup();
  const id = "분기/정산?%#";
  expect(await client.request(routingEndpoints.rules.detail, { query: { id } })).toEqual({ rules: [] });
  const url = new URL(String(fetch.mock.calls[0]?.[0]), "https://console.invalid");
  expect(url.pathname).toBe("/admin/routing-rules");
  expect(url.searchParams.get("id")).toBe(id);
});
it.each(["", " padded", "bad\u0000id", "x".repeat(513)])(
  "잘못된 상세 ID를 서버에 보내지 않는다",
  async (id) => {
    const { client, fetch } = setup();
    await expect(client.request(routingEndpoints.rules.detail, { query: { id } })).rejects.toMatchObject({
      kind: "contract",
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([{ rules: [{ id: "partial" }] }, { rules: null }, { rules: [], revision: "order-view" }])(
  "불완전하거나 다른 조회 계약을 상세로 오인하지 않는다",
  async (body) => {
    const { client } = setup(body);
    await expect(
      client.request(routingEndpoints.rules.detail, { query: { id: "one" } }),
    ).rejects.toMatchObject({ kind: "contract" });
  },
);
