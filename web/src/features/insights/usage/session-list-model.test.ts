import { describe, expect, it } from "vitest";

import {
  lastPageIndex,
  pageCount,
  readListState,
  readSessionSort,
  requestsQuery,
  sessionsQuery,
  writeSessionSort,
} from "./session-list-model";

const base = { from: "2026-10-29", to: "2026-11-27", compare: "prev", metric: "sessions" } as const;
const read = (search: string) => readListState(new URLSearchParams(search));

describe("session and request list state", () => {
  it("defaults to the session list, first page, newest activity first", () => {
    expect(read("")).toEqual({
      kind: "sessions",
      page: 0,
      sort: { columnId: "last_at", direction: "desc" },
      completion: "",
      status: "",
      confidence: "",
    });
  });

  it("reads the list, page, sort and list filters from the URL", () => {
    expect(read("list=requests&page=3&status=unclassified&conf=low")).toMatchObject({
      kind: "requests",
      page: 2,
      status: "unclassified",
      confidence: "low",
    });
    expect(read("sort=cost_krw:asc&session_status=confirmed")).toMatchObject({
      sort: { columnId: "cost_krw", direction: "asc" },
      completion: "confirmed",
    });
  });

  it("ignores values it does not know", () => {
    expect(read("list=users&page=x&status=done&conf=huge&session_status=maybe")).toEqual(read(""));
    expect(readSessionSort("password:desc")).toEqual({ columnId: "last_at", direction: "desc" });
    expect(readSessionSort("requests:up")).toEqual({ columnId: "last_at", direction: "desc" });
    expect(readSessionSort("requests:desc:extra")).toEqual({ columnId: "last_at", direction: "desc" });
  });

  it("writes only a non-default sort", () => {
    expect(writeSessionSort({ columnId: "last_at", direction: "desc" })).toBeUndefined();
    expect(writeSessionSort({ columnId: "requests", direction: "desc" })).toBe("requests:desc");
  });

  it("builds the sessions query with paging, sort and completion", () => {
    expect(sessionsQuery(base, read("page=2&sort=requests:desc&session_status=ended_with_error"))).toEqual({
      ...base,
      limit: 25,
      offset: 25,
      sort: "requests:desc",
      session_status: "ended_with_error",
    });
    expect(sessionsQuery(base, read(""))).toEqual({ ...base, limit: 25, offset: 0, sort: "last_at:desc" });
  });

  it("builds the requests query with status and a confidence band", () => {
    expect(requestsQuery(base, read("list=requests&status=review&conf=mid"))).toEqual({
      ...base,
      limit: 25,
      offset: 0,
      status: "review",
      min_conf: 0.5,
      max_conf: 0.75,
    });
    expect(requestsQuery(base, read("list=requests&conf=low"))).toEqual({
      ...base,
      limit: 25,
      offset: 0,
      max_conf: 0.5,
    });
    expect(requestsQuery(base, read("list=requests&conf=high"))).toMatchObject({ min_conf: 0.75 });
  });

  it("counts pages, never fewer than the page on screen", () => {
    expect(pageCount(undefined, 2)).toBe(3);
    expect(pageCount(0, 0)).toBe(1);
    expect(pageCount(51, 0)).toBe(3);
    expect(pageCount(10, 4)).toBe(5);
  });

  it("never offers a page past the largest offset the server answers", () => {
    // Counts stop at 100,000; the last page starts at offset 100,000.
    expect(lastPageIndex).toBe(4000);
    expect(pageCount(100_000, 0)).toBe(4000);
    expect(pageCount(undefined, 4000)).toBe(4001);
    expect(pageCount(100_000, 4000)).toBe(4001);
    const state = readListState(new URLSearchParams("page=4001"));
    expect(sessionsQuery(base, state)).toMatchObject({ offset: 100_000 });
    expect(readListState(new URLSearchParams("page=4002")).page).toBe(0);
  });
});
