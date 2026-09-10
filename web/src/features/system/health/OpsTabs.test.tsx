import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemHealthPage } from "@/features/system/health/SystemHealthPage";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    backendVersion: "v0.84.1",
    legacyFallback: true,
    mode: "authenticated",
    user: { scopes: ["admin:read"] },
  }),
}));

const opsHome = {
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

const incidents = {
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

const workers = {
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

const preflight = {
  version: "v0.84.1",
  overall: "warn",
  note: "fail이 있으면 배포를 보류하세요.",
  checks: [
    { name: "db_migration", status: "ok", detail: "최신" },
    { name: "auth_secret", status: "warn", detail: "기본값 사용 중" },
  ],
};

const indexHealth = {
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

const migrationSql = {
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

const risk = {
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

function mockOpsApi() {
  return mockApi({
    "GET /admin/ops/risk": () => risk,
    "GET /admin/ops/home": () => opsHome,
    "GET /admin/incidents/candidates": () => incidents,
    "GET /admin/ops/workers": () => workers,
    "GET /admin/ops/preflight": () => preflight,
    "GET /admin/index-health": () => indexHealth,
    "GET /admin/migration-sql": () => migrationSql,
  });
}

describe("system health operations tabs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the operations home cards and the incidents worst first", async () => {
    mockOpsApi();
    renderScreen(<SystemHealthPage />, { path: "/system/health/*", route: "/system/health?tab=ops" });

    expect(await screen.findByText("₩120,000")).toBeVisible();
    // The card links into the new console, not back into the legacy one.
    expect(screen.getByRole("link", { name: /비용/ })).toHaveAttribute("href", "/app/finops");

    const list = await screen.findByRole("list", { name: "장애 후보" });
    // Only the incidents themselves: each one nests its own list of recommended actions.
    const titles = [...list.querySelectorAll(":scope > li")].map((item) => item.textContent ?? "");
    expect(titles[0]).toContain("공급자 장애");
    expect(titles[1]).toContain("비용 급증");
  });

  it("runs the preflight check only when asked", async () => {
    const api = mockOpsApi();
    const user = userEvent.setup();
    renderScreen(<SystemHealthPage />, { path: "/system/health/*", route: "/system/health?tab=workers" });

    expect(await screen.findByText("async-logger")).toBeVisible();
    expect(api.calls.some((call) => call.key === "GET /admin/ops/preflight")).toBe(false);

    await user.click(screen.getByRole("button", { name: /점검 실행/ }));
    expect(await screen.findByText("db_migration")).toBeVisible();
    expect(api.calls.filter((call) => call.key === "GET /admin/ops/preflight")).toHaveLength(1);
  });

  it("shows index drift and opens the migration SQL only on request", async () => {
    const api = mockOpsApi();
    const user = userEvent.setup();
    renderScreen(<SystemHealthPage />, { path: "/system/health/*", route: "/system/health?tab=indexes" });

    expect(await screen.findByText("idx_requests_created")).toBeVisible();
    expect(screen.getByText("DROP INDEX idx_requests_created;")).toBeVisible();
    expect(api.calls.some((call) => call.key === "GET /admin/migration-sql")).toBe(false);

    await user.click(screen.getByRole("button", { name: /마이그레이션 SQL 보기/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("CREATE TABLE requests (id TEXT PRIMARY KEY);")).toBeVisible();

    // "이 DB와 다른 인덱스만" keeps the mismatched index and drops the plain table statement.
    await user.click(within(dialog).getByLabelText("이 DB와 다른 인덱스만"));
    expect(
      within(dialog).queryByText("CREATE TABLE requests (id TEXT PRIMARY KEY);"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("CREATE INDEX idx_requests_created ON requests(created_at);"),
    ).toBeVisible();
  });

  it("has no automated accessibility violations on the operations home", async () => {
    mockOpsApi();
    const { container } = renderScreen(<SystemHealthPage />, {
      path: "/system/health/*",
      route: "/system/health?tab=ops",
    });

    await screen.findByRole("list", { name: "장애 후보" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
