import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { ipFixture, ipDetailFixture } from "@/test/ip-usage";
import { readIpList, readIpDetail } from "./ip-usage-api";
import { readIpSort, sumIpMetric, validIpIdentity } from "./ip-usage-model";
import { orderIpRows } from "./ip-table-model";
const scope = () => ({ signal: new AbortController().signal, prefixes: ["vc_sk_", "custom-private-"] });

describe("IP usage transport and metadata projection", () => {
  it("excludes malformed historical address groups before caching and reports their count", async () => {
    mockApi({
      "GET /admin/ips": () => ({ ips: [ipFixture(), ipFixture("PRIVATE_INVALID_ADDRESS_FIXTURE")] }),
    });
    const data = await readIpList(scope());
    expect(data.excluded).toBe(1);
    expect(data.ips).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("PRIVATE_INVALID");
  });
  it("uses the stored IPv6 spelling and real key/date/estimated_cost fields, without caching raw request fields", async () => {
    const api = mockApi({ "GET /admin/ips/2001%3A0db8%3A%3A1": () => ipDetailFixture() });
    const data = await readIpDetail(scope(), "2001:0db8::1");
    expect(data.stats.ip).toBe("2001:0db8::1");
    expect(data.daily?.[0]?.date).toBe("2026-11-12");
    expect(data.by_model?.[34]?.key).toBe("모델-35");
    expect(data.by_key?.[0]?.key).toBe("key_public_id");
    expect(data.recent?.[0]?.estimated_cost).toBe(125.25);
    expect(JSON.stringify(data)).not.toContain("PRIVATE_");
    expect(api.spy.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", query: { limit: 100 } });
  });
  it("distinguishes missing metrics and missing child collections from true zero and empty", async () => {
    mockApi({
      "GET /admin/ips": () => ({ ips: [{ ip: "192.0.2.1", requests: 0 }] }),
      "GET /admin/ips/192.0.2.1": () => ({ stats: { ip: "192.0.2.1" }, daily: [] }),
    });
    const list = await readIpList(scope());
    expect(list.ips[0]?.requests).toBe(0);
    expect(list.ips[0]?.cost_krw).toBeUndefined();
    expect(sumIpMetric(list.ips, (row) => row.cost_krw)).toBeUndefined();
    const detail = await readIpDetail(scope(), "192.0.2.1");
    expect(detail.daily).toEqual([]);
    expect(detail.by_model).toBeUndefined();
  });
  it("masks configured secret labels while retaining numeric aggregates", async () => {
    const value = ipDetailFixture("192.0.2.1");
    value.by_model = value.by_model.map((row, index) =>
      index === 0 ? { ...row, key: "custom-private-" + "x".repeat(32) } : row,
    );
    mockApi({ "GET /admin/ips/192.0.2.1": () => value });
    const data = await readIpDetail(scope(), "192.0.2.1");
    expect(JSON.stringify(data)).not.toContain("custom-private-");
    expect(data.by_model?.[0]?.requests).toBe(35);
  });
  it.each([
    "../",
    "192.0.2.1/extra",
    "[::1]",
    "fe80::1%eth0",
    "2001:db8::1\n",
    "https://example.com",
    "unknown?x=1",
    "999.1.1.1",
  ])("never sends malformed IP %s", async (ip) => {
    const api = mockApi({});
    expect(validIpIdentity(ip, scope().prefixes)).toBe(false);
    await expect(readIpDetail(scope(), ip)).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
  it.each(["192.0.2.1", "2001:0db8::1", "::ffff:192.0.2.1", "unknown"])("retains valid identity %s", (ip) => {
    expect(validIpIdentity(ip, scope().prefixes)).toBe(true);
  });
  it("rejects another IP response and duplicate request identities", async () => {
    let body = ipDetailFixture("192.0.2.2");
    mockApi({ "GET /admin/ips/192.0.2.1": () => body });
    await expect(readIpDetail(scope(), "192.0.2.1")).rejects.toThrow();
    body = ipDetailFixture("192.0.2.1");
    body.recent = [...body.recent, ...body.recent];
    await expect(readIpDetail(scope(), "192.0.2.1")).rejects.toThrow();
  });
  it("rejects invalid metrics and duplicate IP rows instead of summing misleading totals", async () => {
    let body = { ips: [ipFixture("192.0.2.1", -1)] };
    mockApi({ "GET /admin/ips": () => body });
    await expect(readIpList(scope())).rejects.toThrow();
    body = { ips: [ipFixture("192.0.2.1"), ipFixture("192.0.2.1")] };
    await expect(readIpList(scope())).rejects.toThrow();
  });
});

it("sorts the complete filtered set with stable ties and unknowns last before pagination and CSV", () => {
  const rows = [
    { name: "a", count: 2, cost: 3 },
    { name: "b", count: 2, cost: 9 },
    { name: "c", count: undefined, cost: 100 },
    { name: "d", count: 2, cost: 9 },
  ];
  const columns = [
    { id: "name", header: "이름", value: (row: (typeof rows)[number]) => row.name },
    { id: "count", header: "요청", value: (row: (typeof rows)[number]) => row.count },
    { id: "cost", header: "비용", value: (row: (typeof rows)[number]) => row.cost },
  ];
  expect(
    orderIpRows(
      rows,
      columns,
      "",
      readIpSort(
        "count:desc,cost:desc",
        columns.map((column) => column.id),
      ),
    ).map((row) => row.name),
  ).toEqual(["b", "d", "a", "c"]);
  expect(orderIpRows(rows, columns, "100", []).map((row) => row.name)).toEqual(["c"]);
  expect(readIpSort("cost:desc,cost:asc", ["cost"])).toEqual([]);
  expect(readIpSort("cost:invalid", ["cost"])).toEqual([]);
});
