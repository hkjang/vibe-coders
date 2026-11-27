import { describe, expect, it } from "vitest";

import { categoryPaint, failedId, restId, unclassifiedId } from "@/features/insights/charts/palette";
import type { WorkCategories } from "@/shared/api/domains/insights-usage";

import { breakdownColumns, rowSelectable, rowShare } from "./category-format";
import { breakdownEmpty, breakdownRows, breakdownWithheld, foldBreakdown } from "./category-view";

const metrics = (sessions: number, users: number | null = sessions) => ({
  sessions,
  requests: sessions * 4,
  users,
  tokens: sessions * 1000,
  cost_krw: sessions * 50,
  mcp_calls: 0,
  suppressed: false,
});
/** A group the server withheld from a caller who may not see raw prompts: every measure null. */
const withheld = () => ({
  sessions: null,
  requests: null,
  users: null,
  tokens: null,
  cost_krw: null,
  mcp_calls: null,
  suppressed: true,
});
const ref = (id: string, name: string) => ({
  id,
  name,
  level: id.split(".").length,
  parent_id: "",
  top_id: id.split(".")[0] ?? id,
  enabled: true,
});
const scope = {
  from: "2026-10-29",
  to: "2026-11-27",
  prev_from: "2026-09-29",
  prev_to: "2026-10-28",
  team_scoped: false,
  min_group_size: 3,
  data_through: "2026-11-27T00:00:00Z",
  backlog: 0,
  classify_enabled: true,
  policy_version: 2,
  small_groups_withheld: true,
};

function response(overrides: Partial<WorkCategories> = {}): WorkCategories {
  return {
    scope,
    parent: null,
    rows: [
      {
        category: ref("data", "데이터 분석"),
        current: metrics(30),
        previous: metrics(40),
        share: 0.2,
        delta: null,
        has_children: true,
        suppressed: false,
      },
      {
        category: ref("dev", "소프트웨어 개발"),
        current: metrics(90),
        previous: metrics(60),
        share: 0.6,
        delta: null,
        has_children: true,
        suppressed: false,
      },
      {
        category: ref("security", "정보보호"),
        current: withheld(),
        previous: null,
        share: null,
        delta: null,
        has_children: false,
        suppressed: true,
      },
    ],
    unclassified: metrics(20),
    failed: metrics(0),
    total: metrics(150),
    ...overrides,
  };
}

describe("breakdownRows", () => {
  it("orders categories by the metric, withheld last, then unclassified and failed", () => {
    const rows = breakdownRows(response(), "sessions");
    expect(rows.map((row) => row.id)).toEqual(["dev", "data", "security", unclassifiedId, failedId]);
    expect(rows.map((row) => row.kind)).toEqual([
      "category",
      "category",
      "category",
      "unclassified",
      "failed",
    ]);
  });

  it("reads the selected metric and the change from the previous period", () => {
    const [dev, data] = breakdownRows(response(), "cost");
    expect(dev).toMatchObject({ value: 4500, previous: 3000, change: 0.5, share: 0.6, hasChildren: true });
    expect(data).toMatchObject({ value: 1500, previous: 2000, change: -0.25 });
  });

  it("withholds the value, share and change of a suppressed row", () => {
    const suppressed = breakdownRows(response(), "sessions").find((row) => row.id === "security");
    expect(suppressed).toMatchObject({ value: null, share: null, change: undefined, suppressed: true });
  });

  it("writes every measure of a suppressed row as 보호됨, never as 0", () => {
    const rows = breakdownRows(response(), "cost");
    const suppressed = rows.find((row) => row.id === "security");
    if (!suppressed) throw new Error("missing row");
    const texts = Object.fromEntries(
      breakdownColumns("cost", true).map((column) => [column.id, column.value(suppressed)]),
    );
    expect(texts).toEqual({
      value: "보호됨",
      previous: "—",
      change: "보호됨",
      share: "보호됨",
      users: "보호됨",
      cost: "보호됨",
    });
    expect(rowShare(suppressed)).toBe("보호됨");
  });

  it("keeps a shown current period apart from a withheld previous one", () => {
    const data = response();
    const [first] = data.rows;
    if (!first) throw new Error("missing row");
    const rows = breakdownRows({ ...data, rows: [{ ...first, previous: withheld() }] }, "sessions");
    const [row] = rows;
    expect(row).toMatchObject({ value: 30, previous: null, previousSuppressed: true, change: undefined });
    const texts = Object.fromEntries(
      breakdownColumns("sessions", true).map((column) => [column.id, row ? column.value(row) : ""]),
    );
    expect(texts).toMatchObject({ value: "30", previous: "보호됨", change: "보호됨", share: "20.0%" });
  });

  it("withholds unclassified, failed and the total when the server does, whatever their user count", () => {
    // A complementary rule can withhold a larger cell so a small one cannot be recovered by subtraction.
    const rows = breakdownRows(response({ unclassified: withheld(), total: withheld() }), "sessions");
    const unclassified = rows.find((row) => row.id === unclassifiedId);
    expect(unclassified).toMatchObject({ value: null, share: null, suppressed: true });
    expect(rows.find((row) => row.id === failedId)).toMatchObject({ value: 0, share: 0 });
    // A withheld special row may well have requests, so it still leads to them.
    expect(unclassified && rowSelectable(unclassified)).toBe(true);
    const cost = breakdownColumns("sessions", false).find((column) => column.id === "cost");
    expect(unclassified && cost?.value(unclassified)).toBe("보호됨");
  });

  it("always includes unclassified and failed, with a share of the level's total", () => {
    const rows = breakdownRows(response(), "sessions");
    expect(rows.at(-2)).toMatchObject({ id: unclassifiedId, label: "미분류", value: 20, hasChildren: false });
    expect(rows.at(-2)?.share).toBeCloseTo(20 / 150);
    expect(rows.at(-1)).toMatchObject({ id: failedId, label: "분류 실패", value: 0, share: 0 });
  });

  it("paints top-level rows by identity and the special rows apart", () => {
    const rows = breakdownRows(response(), "sessions");
    expect(rows[0]?.paint).toEqual(categoryPaint("dev"));
    expect(rows.at(-2)?.paint.colorVar).toBe("--wi-cat-unclassified");
    expect(rows.at(-1)?.paint.colorVar).toBe("--wi-cat-failed");
  });

  it("paints the children of one category apart from each other", () => {
    const rows = breakdownRows(
      response({
        parent: ref("dev", "소프트웨어 개발"),
        rows: ["dev.codegen", "dev.review", "dev.test"].map((id, index) => ({
          category: ref(id, id),
          current: metrics(10 - index),
          previous: null,
          share: 0.3,
          delta: null,
          has_children: false,
          suppressed: false,
        })),
      }),
      "sessions",
    );
    const keys = rows.filter((row) => row.kind === "category").map((row) => row.paint.key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("foldBreakdown", () => {
  const many = response({
    rows: Array.from({ length: 10 }, (_, index) => ({
      category: ref(`c${index}`, `업무 ${index}`),
      current: metrics(100 - index * 10),
      previous: null,
      share: 0.05,
      delta: null,
      has_children: false,
      suppressed: false,
    })),
  });

  it("keeps the largest, sums the rest and leaves the special rows alone", () => {
    const folded = foldBreakdown(breakdownRows(many, "sessions"), 6);
    expect(folded.map((row) => row.id)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      restId,
      unclassifiedId,
      failedId,
    ]);
    const rest = folded.find((row) => row.id === restId);
    expect(rest).toMatchObject({ label: "그 외 4개", value: 40 + 30 + 20 + 10, kind: "rest" });
    expect(rest?.share).toBeCloseTo(0.2);
    expect(rest?.metrics.users).toBeNull();
  });

  it("skips withheld rows in the remainder, and withholds it when every folded row is withheld", () => {
    const partly = response({
      rows: many.rows.map((row, index) =>
        index === 9 ? { ...row, current: withheld(), share: null, suppressed: true } : row,
      ),
    });
    const rest = foldBreakdown(breakdownRows(partly, "sessions"), 6).find((row) => row.id === restId);
    expect(rest).toMatchObject({ value: 40 + 30 + 20, share: null, suppressed: false });
    expect(rest?.metrics.cost_krw).toBe((40 + 30 + 20) * 50);

    const hidden = response({
      rows: many.rows.map((row, index) =>
        index >= 6 ? { ...row, current: withheld(), share: null, suppressed: true } : row,
      ),
    });
    const all = foldBreakdown(breakdownRows(hidden, "sessions"), 6).find((row) => row.id === restId);
    expect(all).toMatchObject({ value: null, suppressed: true });
    expect(all?.metrics.sessions).toBeNull();
  });

  it("does not fold when only one row would be folded", () => {
    const rows = breakdownRows(response(), "sessions");
    expect(foldBreakdown(rows, 2)).toEqual(rows);
  });
});

describe("breakdownEmpty", () => {
  it("is empty only when nothing was recorded at all", () => {
    expect(breakdownEmpty(response())).toBe(false);
    expect(
      breakdownEmpty(response({ rows: [], unclassified: metrics(0), failed: metrics(0), total: metrics(0) })),
    ).toBe(true);
    expect(breakdownEmpty(response({ rows: [], unclassified: metrics(3), total: metrics(3) }))).toBe(false);
    // A withheld level has something in it, it just is not shown.
    expect(
      breakdownEmpty(response({ rows: [], unclassified: withheld(), failed: metrics(0), total: withheld() })),
    ).toBe(false);
  });
});

describe("breakdownWithheld", () => {
  it("is withheld only when there are no rows and the total itself is withheld", () => {
    const tooSmall = response({ rows: [], unclassified: withheld(), failed: withheld(), total: withheld() });
    expect(breakdownWithheld(tooSmall)).toBe(true);
    expect(breakdownWithheld(response())).toBe(false);
    expect(breakdownWithheld(response({ rows: [], total: metrics(0) }))).toBe(false);
  });

  it("lists every row as withheld while the level's total is still shown", () => {
    const data = response();
    const everyRow = response({
      rows: data.rows.map((row) => ({ ...row, current: withheld(), share: null, suppressed: true })),
    });
    expect(breakdownWithheld(everyRow)).toBe(false);
    const rows = breakdownRows(everyRow, "sessions").filter((row) => row.kind === "category");
    expect(rows.map((row) => [row.value, row.suppressed])).toEqual([
      [null, true],
      [null, true],
      [null, true],
    ]);
    expect(rows.map(rowShare)).toEqual(["보호됨", "보호됨", "보호됨"]);
  });
});
