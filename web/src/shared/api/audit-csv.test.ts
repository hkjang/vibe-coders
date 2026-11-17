import { expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { endpoints } from "./endpoints";

const endpoint = endpoints.domains.system.audit.csv;
const csv = "created_at,kind,actor,action,detail_before,detail_after\n";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
it("CSV 동시 401은 한 번 갱신하고 각각 인증된 텍스트 응답을 받는다", async () => {
  let access = "old";
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/auth/refresh")
      return json({
        access_token: "new",
        refresh_token: "new-refresh",
        expires_in: 900,
        refresh_expires_in: 3600,
        token_type: "Bearer",
      });
    return new Headers(init?.headers).get("Authorization") === "Bearer new"
      ? new Response("\uFEFF" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8" } })
      : json({ error: { message: "expired" } }, 401);
  });
  const client = new ApiClient({
    fetch,
    getAccessToken: () => access,
    getRefreshToken: () => "refresh",
    saveTokens: (tokens) => {
      access = tokens.access_token;
    },
  });
  const options = {
    query: { limit: 5000 },
    headers: { Accept: "text/csv" },
    cache: "no-store" as const,
    routeId: "system.settings",
  };
  await expect(
    Promise.all([client.request(endpoint, options), client.request(endpoint, options)]),
  ).resolves.toEqual([csv, csv]);
  expect(fetch.mock.calls.filter(([path]) => String(path) === "/auth/refresh")).toHaveLength(1);
  const requests = fetch.mock.calls.filter(([path]) => String(path).startsWith("/admin/audit-logs.csv"));
  expect(requests).toHaveLength(4);
  for (const [path, init] of requests) {
    expect(path).toBe("/admin/audit-logs.csv?limit=5000");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("Accept")).toBe("text/csv");
    expect(new Headers(init?.headers).get("X-Vibe-Route")).toBe("system.settings");
  }
});

it("헤더가 온 뒤 읽는 중인 CSV도 취소하면 반환하지 않는다", async () => {
  let finish!: (text: string) => void;
  const response = new Response(csv, { headers: { "Content-Type": "text/csv" } });
  const body = vi.spyOn(response, "text").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new ApiClient({ fetch: vi.fn(async () => response) }),
    controller = new AbortController();
  const task = client.request(endpoint, { signal: controller.signal }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
  controller.abort();
  finish(csv);
  await expect(task).resolves.toMatchObject({ kind: "aborted", retryable: false });
});

it.each(["<html>login</html>", "", '{"secret":"private-response"}'])(
  "올바른 CSV 헤더가 없는 성공 응답을 파일로 취급하지 않는다 (%#)",
  async (body) => {
    const client = new ApiClient({
      fetch: vi.fn(
        async () =>
          new Response(body, { headers: { "Content-Type": "text/csv", "X-Request-ID": "public-contract" } }),
      ),
    });
    await expect(client.request(endpoint)).rejects.toMatchObject({
      kind: "contract",
      requestId: "public-contract",
    });
  },
);

it("CSV 오류는 자동 재전송 없이 요청 ID를 보존한다", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: "private-storage", code: "audit_export_failed" } }), {
        status: 503,
        headers: { "Content-Type": "application/json", "X-Request-ID": "public-export-failure" },
      }),
  );
  await expect(new ApiClient({ fetch }).request(endpoint)).rejects.toMatchObject({
    status: 503,
    requestId: "public-export-failure",
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([0, 10001, 1.5])("CSV 조회 상한 %s는 전송 전에 거부한다", async (limit) => {
  const fetch = vi.fn();
  await expect(new ApiClient({ fetch }).request(endpoint, { query: { limit } })).rejects.toMatchObject({
    kind: "contract",
  });
  expect(fetch).not.toHaveBeenCalled();
});
