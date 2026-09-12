import { describe, expect, it, vi } from "vitest";

import { jumpCandidate, jumpItems, matchesQuery, type CommandItem } from "@/app/layouts/command-items";

describe("jumpCandidate", () => {
  it("accepts the identifier shapes an operator pastes from a ticket", () => {
    expect(jumpCandidate("req_01JABCDEF")).toBe("req_01JABCDEF");
    expect(jumpCandidate("  4f9c2b18-4a1e-4d7c-9f0a-1b2c3d4e5f60  ")).toBe(
      "4f9c2b18-4a1e-4d7c-9f0a-1b2c3d4e5f60",
    );
  });

  it("ignores ordinary searches so typing a menu name is not read as an id", () => {
    expect(jumpCandidate("비용")).toBeUndefined(); // too short
    expect(jumpCandidate("시스템 상태")).toBeUndefined(); // has a space
    expect(jumpCandidate("/app/overview")).toBeUndefined(); // a path, not an id
  });

  it("refuses anything that looks like a credential, which must never reach the URL", () => {
    expect(jumpCandidate(`sk-ant-${"a".repeat(40)}`)).toBeUndefined();
    expect(jumpCandidate(`vc_sk_${"b".repeat(30)}`)).toBeUndefined();
    expect(jumpCandidate("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM")).toBeUndefined();
  });
});

describe("jumpItems", () => {
  it("offers the three id filters the request explorer supports", () => {
    const go = vi.fn();
    const items = jumpItems("req_01JABCDEF", go);
    expect(items.map((item) => item.title)).toEqual(["요청 ID로 이동", "추적 ID로 이동", "세션 ID로 이동"]);

    items[0]?.run();
    expect(go).toHaveBeenCalledWith("/observability/requests?request_id=req_01JABCDEF");
  });

  it("percent-encodes the value so it cannot add its own query parameters", () => {
    const go = vi.fn();
    jumpItems("req_a.b:c-d", go)[1]?.run();
    expect(go).toHaveBeenCalledWith("/observability/requests?trace_id=req_a.b%3Ac-d");
  });

  it("offers nothing for a query that is not an identifier", () => {
    expect(jumpItems("요청 탐색기", vi.fn())).toEqual([]);
  });
});

describe("matchesQuery", () => {
  const item: CommandItem = {
    id: "action:theme",
    kind: "action",
    title: "테마 전환",
    hint: "어둡게",
    keywords: ["theme", "dark"],
    run: () => undefined,
  };

  it("matches the title, the hint and the hidden keywords", () => {
    expect(matchesQuery(item, "")).toBe(true);
    expect(matchesQuery(item, "테마")).toBe(true);
    expect(matchesQuery(item, "dark")).toBe(true);
    expect(matchesQuery(item, "어둡게")).toBe(true);
    expect(matchesQuery(item, "라우팅")).toBe(false);
  });
});
