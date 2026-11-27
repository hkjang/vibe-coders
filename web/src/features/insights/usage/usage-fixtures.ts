// Synthetic work-intelligence responses in the shapes of
// docs/WORK_INTELLIGENCE_DESIGN.md §7, for the screen's tests and its Playwright
// spec. Every name and number is made up. This file imports nothing so that both
// Vitest and Playwright can load it.

export type FixtureQuery = Readonly<Record<string, string | number | undefined>>;

const text = (query: FixtureQuery, key: string, fallback = ""): string => {
  const value = query[key];
  return value === undefined || value === "" ? fallback : String(value);
};

export function fixtureScope(query: FixtureQuery = {}, overrides: Record<string, unknown> = {}) {
  return {
    from: text(query, "from", "2026-10-29"),
    to: text(query, "to", "2026-11-27"),
    prev_from: "2026-09-29",
    prev_to: "2026-10-28",
    team_scoped: false,
    min_group_size: 3,
    data_through: "2026-11-27T02:10:00Z",
    backlog: 0,
    classify_enabled: true,
    policy_version: 4,
    small_groups_withheld: false,
    ...overrides,
  };
}

const ref = (id: string, name: string) => {
  const parts = id.split(".");
  return {
    id,
    name,
    level: parts.length,
    parent_id: parts.slice(0, -1).join("."),
    top_id: parts[0] ?? id,
    enabled: true,
  };
};

export const fixtureCategories = {
  dev: ref("dev", "소프트웨어 개발"),
  data: ref("data", "데이터 분석"),
  office: ref("office", "일반 사무"),
  security: ref("security", "정보보호"),
  codegen: ref("dev.codegen", "코드 생성"),
  review: ref("dev.review", "코드 리뷰"),
  test: ref("dev.test", "테스트 작성"),
  api: ref("dev.codegen.api", "API 구현"),
  ui: ref("dev.codegen.ui", "화면 구현"),
  sql: ref("data.sql", "SQL 작성"),
};
const cat = fixtureCategories;

const metrics = (sessions: number, users: number | null = Math.max(3, Math.round(sessions / 12))) => ({
  sessions,
  requests: sessions * 6,
  users,
  tokens: sessions * 4_200,
  cost_krw: sessions * 310,
  mcp_calls: Math.round(sessions / 3),
  suppressed: false,
});

/**
 * A group withheld from a caller who may not see raw prompts: every measure is
 * null together. The server also withholds a larger group when a small one could
 * otherwise be recovered by subtraction.
 */
export const fixtureWithheld = () => ({
  sessions: null,
  requests: null,
  users: null,
  tokens: null,
  cost_krw: null,
  mcp_calls: null,
  suppressed: true,
});

/** A value in the unit of the requested metric, so a metric switch changes what is drawn. */
const inMetric = (query: FixtureQuery, sessions: number): number => {
  switch (text(query, "metric", "sessions")) {
    case "requests":
      return sessions * 6;
    case "users":
      return Math.max(3, Math.round(sessions / 12));
    case "tokens":
      return sessions * 4_200;
    case "cost":
      return sessions * 310;
    case "mcp_calls":
      return Math.round(sessions / 3);
    default:
      return sessions;
  }
};

export function fixtureStatus(overrides: Record<string, unknown> = {}) {
  return {
    classify_enabled: true,
    analytics_enabled: true,
    llm_enabled: false,
    llm_model: "",
    llm_external_allowed: false,
    policy_version: 4,
    cursor_at: "2026-11-27T02:10:00Z",
    lag_seconds: 12,
    backlog: 0,
    last_run_at: "2026-11-27T02:10:05Z",
    last_error: "",
    processed_total: 48_200,
    processed_24h: 1_930,
    by_method: { rule: 1_500, cache: 380, manual: 50 },
    failures_24h: 0,
    llm_calls_24h: 0,
    llm_tokens_24h: 0,
    llm_cost_krw_24h: 0,
    cache_hits_24h: 380,
    worker_active: true,
    ...overrides,
  };
}

export function fixtureOverview(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const compare = text(query, "compare", "prev") !== "none";
  const current = {
    ...metrics(1_240, 86),
    teams: 7,
    active_categories: 9,
    classified_rate: 0.92,
    new_categories: 2,
    automation_candidates: 5,
  };
  const previous = {
    ...metrics(1_000, 80),
    teams: 6,
    active_categories: 8,
    classified_rate: 0.9,
    new_categories: 1,
    automation_candidates: 4,
  };
  return {
    scope: fixtureScope(query, scope),
    current,
    previous: compare ? previous : null,
    growth_rate: compare ? 0.24 : null,
    confidence: [
      { bucket: "0.9 이상", requests: 4_100 },
      { bucket: "0.75–0.9", requests: 2_300 },
      { bucket: "0.6–0.75", requests: 700 },
      { bucket: "0.5–0.6", requests: 240 },
      { bucket: "0.5 미만", requests: 100 },
    ],
    methods: [
      { method: "rule", requests: 5_600 },
      { method: "cache", requests: 1_700 },
      { method: "manual", requests: 140 },
    ],
    statuses: [
      { status: "classified", requests: 6_845 },
      { status: "review", requests: 340 },
      { status: "unclassified", requests: 220 },
      { status: "failed", requests: 35 },
    ],
  };
}

const row = (
  category: ReturnType<typeof ref>,
  sessions: number,
  previous: number | null,
  share: number,
  hasChildren: boolean,
  suppressed = false,
) => ({
  category,
  current: suppressed ? fixtureWithheld() : metrics(sessions),
  previous: previous === null ? null : metrics(previous),
  share: suppressed ? null : share,
  delta: suppressed || previous === null || previous === 0 ? null : (sessions - previous) / previous,
  has_children: hasChildren,
  suppressed,
});

export function fixtureCategoryRows(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const parent = text(query, "parent");
  const compare = text(query, "compare", "prev") !== "none";
  const before = (value: number): number | null => (compare ? value : null);
  const base = { scope: fixtureScope(query, scope) };
  if (parent === "dev") {
    return {
      ...base,
      parent: cat.dev,
      rows: [
        row(cat.codegen, 380, before(300), 0.59, true),
        row(cat.review, 170, before(190), 0.27, false),
        row(cat.test, 90, before(60), 0.14, false),
      ],
      unclassified: metrics(0, null),
      failed: metrics(0, null),
      total: metrics(640, 52),
    };
  }
  if (parent === "dev.codegen") {
    return {
      ...base,
      parent: cat.codegen,
      rows: [row(cat.api, 240, before(180), 0.63, false), row(cat.ui, 140, before(120), 0.37, false)],
      unclassified: metrics(0, null),
      failed: metrics(0, null),
      total: metrics(380, 30),
    };
  }
  if (parent === "data") {
    return {
      ...base,
      parent: cat.data,
      rows: [row(cat.sql, 310, before(280), 1, false)],
      unclassified: metrics(0, null),
      failed: metrics(0, null),
      total: metrics(310, 24),
    };
  }
  if (parent) {
    return {
      ...base,
      parent: ref(parent, parent),
      rows: [],
      unclassified: metrics(0, null),
      failed: metrics(0, null),
      total: metrics(0, null),
    };
  }
  return {
    ...base,
    parent: null,
    rows: [
      row(cat.dev, 640, before(480), 0.516, true),
      row(cat.data, 310, before(280), 0.25, true),
      row(cat.office, 220, before(200), 0.177, false),
      row(cat.security, 12, null, 0.01, false, true),
    ],
    unclassified: metrics(48, null),
    failed: metrics(10, null),
    total: metrics(1_240, 86),
  };
}

export function fixtureTrend(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const week = text(query, "bucket", "day") === "week";
  const buckets = week
    ? ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]
    : ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
  const shape = week ? [1, 1.2, 1.5, 1.4] : [1, 0.4, 0.3, 1.2, 1.4, 1.5, 1.3];
  const parent = text(query, "category");
  const series =
    parent === "dev"
      ? [
          { category: cat.codegen, base: 50 },
          { category: cat.review, base: 24 },
          { category: cat.test, base: 12 },
        ]
      : [
          { category: cat.dev, base: 80 },
          { category: cat.data, base: 40 },
          { category: cat.office, base: 28 },
        ];
  const values = series.map((item) => ({
    category: item.category,
    values: shape.map((factor) => inMetric(query, Math.round(item.base * factor))),
  }));
  const other = shape.map((factor) => inMetric(query, Math.round(6 * factor)));
  return {
    scope: fixtureScope(query, scope),
    buckets,
    series: values,
    other,
    total: buckets.map(
      (_, index) => values.reduce((sum, item) => sum + (item.values[index] ?? 0), 0) + (other[index] ?? 0),
    ),
    suppressed: false,
  };
}

export function fixtureMatrix(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const cell = (categoryId: string, sessions: number | null, users: number | null) => ({
    category_id: categoryId,
    value: sessions === null ? null : inMetric(query, sessions),
    users,
    suppressed: sessions === null,
  });
  return {
    scope: fixtureScope(query, scope),
    categories: [cat.dev, cat.data, cat.office],
    rows: [
      {
        team: "플랫폼팀",
        total: metrics(520, 31),
        cells: [cell("dev", 410, 28), cell("data", 80, 9), cell("office", 30, 6)],
      },
      {
        team: "데이터팀",
        total: metrics(360, 22),
        cells: [cell("dev", 90, 8), cell("data", 230, 20), cell("office", 40, 7)],
      },
      {
        team: "경영지원팀",
        total: metrics(160, 12),
        cells: [cell("dev", null, null), cell("data", 0, 0), cell("office", 150, 12)],
      },
    ],
  };
}

export function fixtureFlow(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const value = (sessions: number): number => inMetric(query, sessions);
  return {
    scope: fixtureScope(query, scope),
    nodes: [
      { id: "team:플랫폼팀", kind: "team", name: "플랫폼팀", value: value(490) },
      { id: "team:데이터팀", kind: "team", name: "데이터팀", value: value(320) },
      { id: "category:dev", kind: "category", name: "소프트웨어 개발", value: value(500) },
      { id: "category:data", kind: "category", name: "데이터 분석", value: value(310) },
      { id: "model:gpt-4.1", kind: "model", name: "gpt-4.1", value: value(520) },
      { id: "model:claude-sonnet", kind: "model", name: "claude-sonnet", value: value(290) },
    ],
    links: [
      { source: "team:플랫폼팀", target: "category:dev", value: value(410) },
      { source: "team:플랫폼팀", target: "category:data", value: value(80) },
      { source: "team:데이터팀", target: "category:dev", value: value(90) },
      { source: "team:데이터팀", target: "category:data", value: value(230) },
      { source: "category:dev", target: "model:gpt-4.1", value: value(330) },
      { source: "category:dev", target: "model:claude-sonnet", value: value(170) },
      { source: "category:data", target: "model:gpt-4.1", value: value(190) },
      { source: "category:data", target: "model:claude-sonnet", value: value(120) },
    ],
    suppressed_links: 0,
    suppressed: false,
  };
}

export function fixtureTeams(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  return {
    scope: fixtureScope(query, scope),
    denominators: "active_users",
    rows: [
      {
        team: "플랫폼팀",
        current: metrics(520, 31),
        previous: metrics(430, 29),
        sessions_per_user: 16.8,
        diversity: 0.62,
        top_categories: [
          { category: cat.dev, value: 410, share: 0.79 },
          { category: cat.data, value: 80, share: 0.15 },
          { category: cat.office, value: 30, share: 0.06 },
        ],
        rising: [{ category: cat.codegen, delta: 64 }],
        deviation: [{ category: cat.dev, team_share: 0.79, overall_share: 0.52 }],
        suppressed: false,
      },
      {
        team: "데이터팀",
        current: metrics(360, 22),
        previous: metrics(350, 21),
        sessions_per_user: 16.4,
        diversity: 0.71,
        top_categories: [
          { category: cat.data, value: 230, share: 0.64 },
          { category: cat.dev, value: 90, share: 0.25 },
        ],
        rising: [{ category: cat.sql, delta: 22 }],
        deviation: [{ category: cat.data, team_share: 0.64, overall_share: 0.25 }],
        suppressed: false,
      },
      {
        team: "보안팀",
        current: fixtureWithheld(),
        previous: null,
        sessions_per_user: null,
        diversity: null,
        top_categories: [],
        rising: [],
        deviation: [],
        suppressed: true,
      },
    ],
  };
}

export function fixtureModels(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const model = (
    category: ReturnType<typeof ref>,
    name: string,
    sessions: number,
    share: number,
    lowSample = false,
  ) => ({
    suppressed: false,
    category,
    model: name,
    provider: name.startsWith("claude") ? "anthropic" : "openai",
    requests: sessions * 6,
    sessions,
    share,
    tokens_per_session: 4_200,
    cost_per_session: name.startsWith("claude") ? 420 : 280,
    latency_p50_ms: 1_800,
    latency_p95_ms: 9_400,
    error_rate: 0.012,
    retry_rate: 0.04,
    model_switch_rate: 0.08,
    feedback_positive: Math.round(sessions / 20),
    feedback_negative: Math.round(sessions / 90),
    low_sample: lowSample,
  });
  return {
    scope: fixtureScope(query, scope),
    rows: [
      model(cat.dev, "gpt-4.1", 420, 0.66),
      model(cat.dev, "claude-sonnet", 220, 0.34),
      model(cat.data, "gpt-4.1", 190, 0.61),
      model(cat.data, "claude-sonnet", 120, 0.39),
      model(cat.office, "gpt-4.1-mini", 9, 0.04, true),
      // Too few users: every measure withheld; its low-sample flag means nothing.
      {
        ...model(cat.security, "claude-haiku", 0, 0, true),
        requests: null,
        sessions: null,
        share: null,
        tokens_per_session: null,
        cost_per_session: null,
        latency_p50_ms: null,
        latency_p95_ms: null,
        error_rate: null,
        retry_rate: null,
        model_switch_rate: null,
        feedback_positive: null,
        feedback_negative: null,
        suppressed: true,
      },
    ],
    suggestions: [
      {
        category: cat.office,
        from_model: "gpt-4.1",
        to_model: "gpt-4.1-mini",
        basis: "오류율과 긍정 피드백 비율이 비슷하고 세션당 비용이 62% 낮음",
        sample: 210,
        est_saving_krw: 38_000,
      },
    ],
    suppressed: false,
  };
}

export function fixtureTrends(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const signal = (
    kind: string,
    category: ReturnType<typeof ref>,
    current: number,
    previous: number,
    extra: Record<string, unknown> = {},
  ) => ({
    kind,
    category,
    team: "",
    model: "",
    current: inMetric(query, current),
    previous: inMetric(query, previous),
    change_abs: inMetric(query, current) - inMetric(query, previous),
    change_rate: previous === 0 ? null : (current - previous) / previous,
    users_current: 14,
    users_previous: 9,
    sample: current * 6,
    note: "",
    ...extra,
  });
  return {
    scope: fixtureScope(query, scope),
    signals: [
      signal("rising_7d", cat.codegen, 120, 70),
      signal("rising_30d", cat.sql, 310, 220),
      signal("new", cat.ui, 40, 0, { users_previous: 0, note: "비교 기간에는 없던 업무입니다." }),
      signal("team_concentrated", cat.review, 170, 190, {
        team: "플랫폼팀",
        note: "사용량의 88%가 한 조직에서 나옵니다.",
      }),
      signal("cost_spike", cat.data, 310, 280, { users_current: null, users_previous: null }),
      signal("model_dependence", cat.dev, 640, 480, { model: "gpt-4.1" }),
    ],
    thresholds: { min_sample: 30, min_change_abs: 20, min_change_rate: 0.25 },
  };
}

export function fixtureAutomationRows() {
  return [
    {
      id: "auto-weekly-report",
      title: "주간 장애 보고서 초안 작성",
      category: cat.office,
      teams: ["경영지원팀", "플랫폼팀"],
      repeats: 42,
      users: 6,
      sessions: 42,
      cost_krw: 18_400,
      avg_latency_ms: 5_200,
      recommended: "prompt_template",
      feasibility: 0.82,
      mcp_tools: ["jira.search"],
      risk: "low",
      needs_approval: false,
      effect: {
        basis: "기준값: 수작업 40분 → AI 10분",
        est_minutes_saved: 1_260,
        est_cost_saved_krw: 1_050_000,
      },
      review_status: "new",
      computed_at: "2026-11-27T00:00:00Z",
    },
    {
      id: "auto-sql-audit",
      title: "배포 전 SQL 점검",
      category: cat.sql,
      teams: ["데이터팀"],
      repeats: 28,
      users: null,
      sessions: 28,
      cost_krw: 9_100,
      avg_latency_ms: 3_900,
      recommended: "mcp_tool",
      feasibility: 0.64,
      mcp_tools: ["warehouse.explain", "warehouse.query"],
      risk: "high",
      needs_approval: true,
      effect: { basis: "", est_minutes_saved: null, est_cost_saved_krw: null },
      review_status: "reviewing",
      computed_at: "2026-11-27T00:00:00Z",
    },
  ];
}

export function fixtureAutomation(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const status = text(query, "status");
  const rows = fixtureAutomationRows().filter((item) => !status || item.review_status === status);
  return { scope: fixtureScope(query, scope), rows, count: rows.length };
}

export function fixtureInsights(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  return {
    scope: fixtureScope(query, scope),
    generated_at: "2026-11-27T00:00:00Z",
    llm_used: false,
    rows: [
      {
        id: "ins-codegen-rise",
        kind: "rising",
        severity: "notice",
        title: "코드 생성 업무가 한 달 새 27% 늘었습니다",
        body: "플랫폼팀이 증가분의 대부분을 차지합니다.",
        evidence: {
          period: "2026-10-29 ~ 2026-11-27",
          compare: "2026-09-29 ~ 2026-10-28",
          sample: 2_280,
          metrics: { 세션: 380, "직전 세션": 300 },
        },
        link: { tab: "categories", parent: "dev" },
        created_at: "2026-11-27T00:00:00Z",
      },
      {
        id: "ins-unclassified",
        kind: "quality",
        severity: "warning",
        title: "미분류 요청이 220건 있습니다",
        body: "",
        evidence: { period: "2026-10-29 ~ 2026-11-27", compare: "", sample: 220, metrics: {} },
        link: {},
        created_at: "2026-11-27T00:00:00Z",
      },
    ],
  };
}

const sessionRow = (index: number) => ({
  session_id: `sess_${String(index).padStart(4, "0")}`,
  session_kind: index % 3 === 0 ? "inferred" : "explicit",
  team: index % 2 === 0 ? "플랫폼팀" : "데이터팀",
  user: index % 4 === 0 ? "" : `u-${String(index).padStart(3, "0")}`,
  client: index % 2 === 0 ? "Claude Code" : "Cursor",
  primary: index % 2 === 0 ? cat.api : cat.sql,
  secondary: index % 5 === 0 ? [cat.review] : [],
  first_at: "2026-11-26T01:00:00Z",
  last_at: "2026-11-26T01:42:00Z",
  requests: 6 + (index % 7),
  mcp_calls: index % 3,
  tokens_in: 21_000,
  tokens_out: 6_400,
  cost_krw: 310 + index,
  duration_ms: 2_520_000,
  model_time_ms: 96_000,
  errors: index % 6 === 0 ? 1 : 0,
  retries: index % 4 === 0 ? 2 : 0,
  models: index % 5 === 0 ? ["gpt-4.1", "claude-sonnet"] : ["gpt-4.1"],
  model_switches: index % 5 === 0 ? 1 : 0,
  policy_flags: [],
  completion: index % 6 === 0 ? "ended_with_error" : index % 3 === 0 ? "confirmed" : "unknown",
});

export const fixtureSessionTotal = 60;

export function fixtureSessions(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const limit = Number(query.limit ?? 25);
  const offset = Number(query.offset ?? 0);
  const completion = text(query, "session_status");
  const all = Array.from({ length: fixtureSessionTotal }, (_, index) => sessionRow(index + 1)).filter(
    (item) => !completion || item.completion === completion,
  );
  return {
    scope: fixtureScope(query, scope),
    rows: all.slice(offset, offset + limit),
    count: all.length,
    limit,
    offset,
  };
}

const requestRow = (index: number, sessionId: string) => ({
  request_id: `req_${String(index).padStart(5, "0")}`,
  created_at: "2026-11-26T01:10:00Z",
  session_id: sessionId,
  team: "플랫폼팀",
  user: index % 3 === 0 ? "" : "u-002",
  client: "Claude Code",
  model: "gpt-4.1",
  category: index % 4 === 0 ? cat.review : cat.api,
  action_type: index % 2 === 0 ? "create" : "modify",
  confidence: index % 5 === 0 ? 0.42 : 0.88,
  method: index % 5 === 0 ? "cache" : "rule",
  status: index % 5 === 0 ? "review" : "classified",
  work_title: `주문 API ${index}번 엔드포인트 구현`,
  tags: ["go"],
  technologies: ["go", "postgres"],
  tokens: 4_100,
  cost_krw: 52,
  latency_ms: 2_300,
  is_error: index % 7 === 0,
  policy_version: 4,
});

export function fixtureSessionDetail(sessionId: string) {
  const index = Number(sessionId.replace(/\D/gu, "")) || 2;
  return {
    session: { ...sessionRow(index), session_id: sessionId },
    segments: [
      {
        category: cat.dev,
        requests: 5,
        cost_krw: 260,
        first_at: "2026-11-26T01:00:00Z",
        last_at: "2026-11-26T01:30:00Z",
      },
      {
        category: cat.data,
        requests: 2,
        cost_krw: 52,
        first_at: "2026-11-26T01:31:00Z",
        last_at: "2026-11-26T01:42:00Z",
      },
    ],
    requests: Array.from({ length: 7 }, (_, offset) => requestRow(offset + 1, sessionId)),
  };
}

export const fixtureRequestTotal = 40;

export function fixtureRequests(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  const limit = Number(query.limit ?? 25);
  const offset = Number(query.offset ?? 0);
  const status = text(query, "status");
  const all = Array.from({ length: fixtureRequestTotal }, (_, index) =>
    requestRow(index + 1, `sess_${String((index % 9) + 1).padStart(4, "0")}`),
  ).map((item) => (status === "unclassified" || status === "failed" ? { ...item, status } : item));
  const rows = all.filter((item) => !status || item.status === status);
  return {
    scope: fixtureScope(query, scope),
    rows: rows.slice(offset, offset + limit),
    count: rows.length,
    limit,
    offset,
  };
}

export function fixtureProductivity(query: FixtureQuery = {}, scope: Record<string, unknown> = {}) {
  return {
    scope: fixtureScope(query, scope),
    rows: [
      {
        category: cat.dev,
        sessions: 640,
        confirmed_sessions: 120,
        model_time_ms: 61_000_000,
        baseline: { manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50_000 },
        est_minutes_saved: 5_400,
        est_cost_saved_krw: 4_500_000,
        reason: "완료가 확인된 120개 세션에 기준값을 적용했습니다.",
        suppressed: false,
      },
      {
        category: cat.data,
        sessions: 310,
        confirmed_sessions: 0,
        model_time_ms: 22_000_000,
        baseline: { manual_minutes: 45, ai_minutes: 20, hourly_cost_krw: 50_000 },
        est_minutes_saved: null,
        est_cost_saved_krw: null,
        reason: "완료가 확인된 세션이 없어 추정하지 않습니다.",
        suppressed: false,
      },
      {
        category: cat.office,
        sessions: 220,
        confirmed_sessions: 31,
        model_time_ms: 9_000_000,
        baseline: null,
        est_minutes_saved: null,
        est_cost_saved_krw: null,
        reason: "기준값이 등록되지 않았습니다.",
        suppressed: false,
      },
      {
        category: cat.security,
        sessions: null,
        confirmed_sessions: null,
        model_time_ms: null,
        baseline: { manual_minutes: 30, ai_minutes: 10, hourly_cost_krw: 50_000 },
        est_minutes_saved: null,
        est_cost_saved_krw: null,
        reason: "사용자가 적어 개인을 추정할 수 없도록 수치를 가렸습니다.",
        suppressed: true,
      },
    ],
    suppressed: false,
  };
}

/** Every analytics read by its path under `/admin/work-intel`, for a router-style mock. */
export const fixtureReads: Readonly<Record<string, (query: FixtureQuery) => unknown>> = {
  overview: fixtureOverview,
  categories: fixtureCategoryRows,
  trend: fixtureTrend,
  matrix: fixtureMatrix,
  flow: fixtureFlow,
  teams: fixtureTeams,
  models: fixtureModels,
  trends: fixtureTrends,
  automation: fixtureAutomation,
  insights: fixtureInsights,
  sessions: fixtureSessions,
  requests: fixtureRequests,
  productivity: fixtureProductivity,
  status: () => fixtureStatus(),
};
