import { expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { endpoints } from "./endpoints";

it("키 목록과 정확한 상세가 공통 클라이언트에서 검증된 주소로 전송된다", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({ api_keys: [], revoke_review_supported: true, edit_review_supported: true }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  const client = new ApiClient({ fetch });
  await expect(client.request(endpoints.domains.access.apiKeys.list)).resolves.toMatchObject({
    api_keys: [],
  });
  await expect(
    client.request(endpoints.domains.access.apiKeys.list, { query: { id: "key_one:scope" } }),
  ).resolves.toMatchObject({ api_keys: [] });
  expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
    "/admin/api-keys",
    "/admin/api-keys?id=key_one%3Ascope",
  ]);
});
it.each(["", "bad/id", "key%20", "x".repeat(513), "Key_one"])(
  "잘못된 상세 ID를 네트워크에 보내지 않는다 (%s)",
  async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ApiClient({ fetch });
    await expect(
      client.request(endpoints.domains.access.apiKeys.list, { query: { id } }),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(fetch).not.toHaveBeenCalled();
  },
);
