// Synthetic operating snapshots for isolated UI tests.
export const opsHome = {
  window_hours: 24,
  overall: "warn",
  generated_at: "2026-09-10T00:00:00Z",
  cards: [
    {
      key: "cost",
      title: "비용",
      status: "warn",
      value: "₩120,000",
      detail: "어제보다 40% 증가",
      link: "#/billing",
    },
    { key: "mcp", title: "MCP 실패", status: "ok", value: "0건", detail: "", link: "#/mcp" },
  ],
};

export const incidents = {
  window_hours: 24,
  total: 2,
  note: "임계치를 넘은 신호만 표시합니다.",
  counts: { critical: 1, warning: 1 },
  incidents: [
    {
      id: "inc-warn",
      severity: "warning",
      category: "cost",
      title: "비용 급증",
      summary: "어제 대비 40% 증가했습니다.",
      recommended_actions: ["예산 알림 확인"],
    },
    {
      id: "inc-critical",
      severity: "critical",
      category: "routing",
      title: "공급자 장애",
      summary: "openai 응답이 실패하고 있습니다.",
      recommended_actions: ["대체 공급자 확인"],
    },
  ],
};

export const workers = {
  overall: "warn",
  workers: [
    { name: "async-logger", status: "ok", running: true, queue_depth: 2, capacity: 100, dropped: 0 },
    {
      name: "anomaly-worker",
      status: "warn",
      running: true,
      queue_depth: 0,
      dropped: 3,
      detail: "유실 발생",
    },
  ],
};

export const preflight = {
  version: "v0.84.1",
  overall: "warn",
  note: "fail이 있으면 배포를 보류하세요.",
  checks: [
    { name: "db_migration", status: "ok", detail: "최신" },
    { name: "auth_secret", status: "warn", detail: "기본값 사용 중" },
  ],
};

export const indexHealth = {
  summary: {
    in_sync: false,
    mismatched: 1,
    missing: 0,
    undeclared: 0,
    advice_high: 1,
    advice_total: 1,
    headline: "인덱스 1개가 선언과 다릅니다.",
  },
  drift: {
    dialect: "sqlite",
    declared_count: 40,
    items: [
      {
        kind: "mismatched",
        name: "idx_requests_created",
        table: "requests",
        detail: "컬럼 순서가 다릅니다.",
        fix: "DROP INDEX idx_requests_created;",
      },
    ],
  },
  advice: {
    dialect: "sqlite",
    limitations: ["SQLite는 인덱스 사용 통계를 제공하지 않습니다."],
    items: [
      {
        kind: "add",
        severity: "high",
        table: "requests",
        columns: ["team_id", "created_at"],
        reason: "팀 범위 조회가 전체 스캔입니다.",
        evidence: "seq_scan 1,200",
        sql: "CREATE INDEX idx_requests_team ON requests(team_id, created_at);",
      },
    ],
  },
};

export const migrationSql = {
  dialect: "sqlite",
  counts: { total: 2, create_table: 1, create_index: 1, add_column: 0, other: 0, rewritten: 0 },
  index_status: { idx_requests_created: "mismatched" },
  index_detail: { idx_requests_created: "컬럼 순서가 다릅니다." },
  statements: [
    { seq: 1, kind: "create_table", table: "requests", sql: "CREATE TABLE requests (id TEXT PRIMARY KEY);" },
    {
      seq: 2,
      kind: "create_index",
      table: "requests",
      name: "idx_requests_created",
      sql: "CREATE INDEX idx_requests_created ON requests(created_at);",
    },
  ],
};

export const risk = {
  risk: { score: 10, tier: "low", factors: [] },
  status: {
    generated_at: "2026-09-10T00:00:00Z",
    providers: [],
    logging: { queue_depth: 0, written: 0, dropped: 0 },
    fallback: { path: "/data/fallback.ndjson", exists: false, lines: 0, bytes: 0 },
    security: {
      auth_enabled: true,
      dev_secret: false,
      raw_prompts_logged: false,
      raw_bodies_logged: false,
      pricing_configured: true,
    },
    disk: { path: "/data", available: true, free_bytes: 1024, total_bytes: 2048, used_percent: 50 },
  },
};
