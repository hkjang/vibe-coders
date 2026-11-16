import { describe, expect, it } from "vitest";
import {
  reviewCurrentRequestCriteria,
  reviewSavedRequestCriteria,
  savedFilterNameError,
  visibleRequestFilters,
} from "./request-saved-filter";

describe("request shared filter criteria", () => {
  it("saves applied criteria without the expiring page cursor and previews Korean statuses", () => {
    const review = reviewCurrentRequestCriteria(
      { model: "운영 모델", status: "5xx", limit: 25, tz: "UTC", cursor: "opaque" },
      [],
    );
    expect(review.criteria?.params).toBe(
      "tz=UTC&status=5xx&model=%EC%9A%B4%EC%98%81+%EB%AA%A8%EB%8D%B8&limit=25",
    );
    expect(review.criteria?.entries).toContainEqual({ label: "상태", value: "서버 오류 (5xx)" });
  });
  it("explicitly previews default timezone and page size for an empty compatible legacy filter", () => {
    expect(reviewSavedRequestCriteria("", []).criteria?.entries).toEqual([
      { label: "표시 건수", value: "50" },
      { label: "시간대", value: "Asia/Seoul" },
    ]);
  });
  it.each([
    "model=a&model=b",
    "provider=legacy-provider",
    "cursor=expired",
    "prompt=private",
    "status=all",
    "limit=201",
    "tz=bad-zone",
    "ip=invalid",
    "from=2026-02-30",
    "to=2026-01-01&from=2026-02-01",
    "model=%ZZ",
    "model=%FF",
    "language=%00",
    "model=+spaces+",
    "__proto__=x",
  ])("refuses the whole incompatible filter %s without echoing raw conditions", (params) => {
    expect(reviewSavedRequestCriteria(params, [])).toEqual({ error: expect.any(String) });
  });
  it("does not expose credential-shaped values or oversized encoded conditions", () => {
    const secret = `corp_${"q".repeat(35)}`;
    const review = reviewSavedRequestCriteria(`model=${secret}`, ["corp_"]);
    expect(review.error).toBeDefined();
    expect(JSON.stringify(review)).not.toContain(secret);
    expect(reviewSavedRequestCriteria(`model=${"x".repeat(4096)}`, []).error).toBeDefined();
  });
  it("filters foreign views, unsafe identifiers and names, and duplicate IDs", () => {
    const filter = {
      id: "filt_1",
      view: "requests",
      name: "운영 오류",
      params: "status=error",
      created_by: "",
      created_at: "",
    };
    expect(
      visibleRequestFilters(
        [
          filter,
          filter,
          { ...filter, id: "filt_2", view: "xview" },
          { ...filter, id: "../../filter" },
          { ...filter, id: "filt_3", name: `corp_${"x".repeat(35)}` },
        ],
        ["corp_"],
      ),
    ).toEqual([filter]);
    expect(savedFilterNameError("a\u202eb", [])).toBeDefined();
    expect(savedFilterNameError(" ", [])).toBeDefined();
    expect(savedFilterNameError("가".repeat(81), [])).toBeDefined();
  });
});
