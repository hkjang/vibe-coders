import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, apiFailure } from "@/test/api";
import { comparisonIdError, loadRequestComparison } from "./request-comparison";
import { comparisonRequest as row, comparisonResponse as response } from "./request-comparison-fixtures";

afterEach(() => vi.restoreAllMocks());
const load = (id = "req-b", assert = () => undefined, signal = new AbortController().signal) =>
  loadRequestComparison(row("req-a"), id, ["corp_"], signal, assert);
describe("request comparison safe transport", () => {
  it("uses only bounded version2 summary reads and preserves actual zero values", async () => {
    const api = mockApi({
      "GET /admin/requests": ({ query }) =>
        response(row(String((query as { request_id: string }).request_id))),
    });
    const pair = await load();
    expect(pair.left.latency_ms).toBe(0);
    expect(pair.right.request_id).toBe("req-b");
    expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/requests", "GET /admin/requests"]);
    expect(api.calls.map((call) => call.options.query)).toEqual([
      { request_id: "req-a", limit: 2 },
      { request_id: "req-b", limit: 2 },
    ]);
    expect(
      api.spy.mock.calls.every(
        (call) => new Headers(call[1]?.headers).get("X-Vibe-App-Requests-Version") === "2",
      ),
    ).toBe(true);
  });
  it("reads the same request once", async () => {
    const api = mockApi({ "GET /admin/requests": () => response(row("req-a")) });
    const pair = await load("req-a");
    expect(pair.left).toBe(pair.right);
    expect(api.calls).toHaveLength(1);
  });
  it.each(["", "corp_" + "a".repeat(32), "req\nprivate", "한".repeat(172)])(
    "rejects invalid IDs before transport",
    async (id) => {
      const api = mockApi({});
      expect(comparisonIdError(id, ["corp_"])).toBeDefined();
      await expect(load(id)).rejects.toThrow();
      expect(api.calls).toHaveLength(0);
    },
  );
  it.each([
    response(),
    response(row("req-a"), row("req-a")),
    response(row("wrong")),
    response({ ...row("req-a"), request_filterable: false }),
    response({ ...row("req-a"), created_at: "2026-10-02T00:00:00Z" }),
    response({ ...row("req-a"), request_ref: `req_${"c".repeat(22)}.${"d".repeat(21)}` }),
    { ...response(row("req-a")), request_contract_version: 1 },
    { ...response(row("req-a")), next_cursor: "unexpected" },
  ])("rejects nonunique, mismatched, old-contract or replaced selected records", async (result) => {
    const api = mockApi({ "GET /admin/requests": () => result });
    await expect(load()).rejects.toThrow();
    expect(api.calls).toHaveLength(1);
  });
  it.each([401, 403, 503])("does not start the other read after first error %i", async (status) => {
    const api = mockApi({
      "GET /admin/requests": () => {
        throw apiFailure("private", status);
      },
    });
    await expect(load()).rejects.toThrow();
    expect(api.calls).toHaveLength(1);
  });
  it("rechecks selection after an async response even when transport ignores cancellation", async () => {
    let current = true;
    const api = mockApi({
      "GET /admin/requests": () => {
        current = false;
        return response(row("req-a"));
      },
    });
    await expect(
      load("req-b", () => {
        if (!current) throw Error("retired");
      }),
    ).rejects.toThrow("retired");
    expect(api.calls).toHaveLength(1);
  });
  it("does not fetch with an already canceled signal", async () => {
    const api = mockApi({});
    const controller = new AbortController();
    controller.abort();
    await expect(load("req-b", () => undefined, controller.signal)).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});
