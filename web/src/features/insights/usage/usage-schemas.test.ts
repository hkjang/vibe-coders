import { describe, expect, it } from "vitest";

import { workQuerySchema } from "@/shared/api/domains/insights-common";
import { insightsUsageEndpoints as api } from "@/shared/api/domains/insights-usage";

// Small-group protection: for a caller who may not see raw prompts the server sends
// a withheld value as null. These cases pin that a null stays null (a 0 would be a
// misleading number) while a value an older server leaves out still reads as 0.

const withheld = {
  sessions: null,
  requests: null,
  users: null,
  tokens: null,
  cost_krw: null,
  mcp_calls: null,
  suppressed: true,
};

describe("usage API schemas", () => {
  it("keeps every withheld measure null and reads a missing one as 0", () => {
    const parsed = api.categories.schema.parse({
      scope: {},
      rows: [
        {
          category: { id: "security", name: "정보보호" },
          current: withheld,
          previous: withheld,
          share: null,
          delta: null,
          suppressed: true,
        },
      ],
      unclassified: withheld,
      failed: { sessions: 2 },
      total: { sessions: 10, requests: 40, users: 5, tokens: 1, cost_krw: 2, mcp_calls: 0 },
    });
    const [row] = parsed.rows;
    expect(row?.current).toMatchObject(withheld);
    expect(row?.previous).toMatchObject(withheld);
    expect(row?.share).toBeNull();
    expect(parsed.unclassified).toMatchObject(withheld);
    expect(parsed.failed).toMatchObject({ sessions: 2, requests: 0, users: null, suppressed: false });
    expect(parsed.total.suppressed).toBe(false);
  });

  it("keeps a withheld overview period null, teams and candidates included as numbers", () => {
    const parsed = api.overview.schema.parse({
      scope: {},
      current: {
        ...withheld,
        teams: 4,
        active_categories: null,
        classified_rate: null,
        new_categories: null,
        automation_candidates: 2,
      },
      previous: null,
      growth_rate: null,
      confidence: [],
    });
    expect(parsed.current).toMatchObject({
      sessions: null,
      teams: 4,
      active_categories: null,
      classified_rate: null,
      new_categories: null,
      automation_candidates: 2,
      suppressed: true,
    });
  });

  it("keeps withheld trend buckets null and reads the flow's withheld link count", () => {
    const trend = api.trend.schema.parse({
      scope: {},
      buckets: ["2026-11-21", "2026-11-22"],
      series: [{ category: { id: "dev" }, values: [5, null] }],
      other: [null, 1],
      total: [8, null],
    });
    expect(trend.series[0]?.values).toEqual([5, null]);
    expect(trend.other).toEqual([null, 1]);
    expect(trend.total).toEqual([8, null]);
    expect(
      api.flow.schema.parse({ scope: {}, nodes: [], links: [], suppressed_links: 3 }).suppressed_links,
    ).toBe(3);
    expect(api.flow.schema.parse({ scope: {} }).suppressed_links).toBe(0);
  });

  it("reads withheld team, model and productivity rows", () => {
    const team = api.teams.schema.parse({
      scope: {},
      rows: [
        { team: "보안팀", current: withheld, diversity: null, sessions_per_user: null, suppressed: true },
      ],
    }).rows[0];
    expect(team).toMatchObject({
      diversity: null,
      sessions_per_user: null,
      suppressed: true,
      top_categories: [],
    });

    const model = api.models.schema.parse({
      scope: {},
      rows: [
        {
          category: { id: "dev" },
          model: "gpt-4.1",
          requests: null,
          sessions: null,
          share: null,
          cost_per_session: null,
          error_rate: null,
          low_sample: true,
          suppressed: true,
        },
      ],
    }).rows[0];
    expect(model).toMatchObject({ sessions: null, share: null, cost_per_session: null, suppressed: true });
    expect(api.models.schema.parse({ scope: {}, rows: [{ category: { id: "dev" } }] }).rows[0]).toMatchObject(
      {
        sessions: 0,
        suppressed: false,
      },
    );

    const productivity = api.productivity.schema.parse({
      scope: {},
      rows: [
        {
          category: { id: "dev" },
          sessions: null,
          confirmed_sessions: null,
          model_time_ms: null,
          est_minutes_saved: null,
          est_cost_saved_krw: null,
          reason: "사용자가 적어 가렸습니다.",
          suppressed: true,
        },
      ],
    }).rows[0];
    expect(productivity).toMatchObject({ sessions: null, model_time_ms: null, suppressed: true });
  });

  it("does not send an offset the server refuses", () => {
    expect(workQuerySchema.safeParse({ offset: 100_000 }).success).toBe(true);
    expect(workQuerySchema.safeParse({ offset: 100_025 }).success).toBe(false);
    expect(api.sessions.querySchema?.safeParse({ offset: 100_025 }).success).toBe(false);
  });
});
