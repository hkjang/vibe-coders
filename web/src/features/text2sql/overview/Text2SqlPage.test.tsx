import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Text2SqlPage } from "@/features/text2sql/overview/Text2SqlPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

// Shaped like the JSON written by handleText2SQLAdmin in internal/proxy/admin_text2sql.go.
const overview = {
  enabled: true,
  stats: { total: 128, valid: 120, executed: 42, errors: 8, cost_krw: 3200, valid_rate: 0.9375 },
  profiles: [{ model: "vibe/text2sql-preview", mode: "preview", upstream: "gpt-4o-mini" }],
  db_profiles: [
    {
      virtual_model: "vibe/text2sql-finance",
      mode: "execute",
      upstream_model: "gpt-4o",
      summary_model: "",
      schema_name: "analytics",
      exec_connection_id: "analytics_db",
      enabled: true,
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
  schemas: [
    {
      team: "",
      name: "analytics",
      dialect: "PostgreSQL",
      schema_text: "orders(order_id, amount)",
      allowed_tables: ["orders"],
      is_default: true,
      enabled: true,
      version: 3,
      collected_at: "2026-08-30T00:00:00Z",
      source_fingerprint: "abc",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
  permissions: [
    {
      id: "t2sp_1",
      subject_type: "team",
      subject_id: "platform",
      schema_name: "analytics",
      table_name: "orders",
      column_name: "phone",
      action: "deny",
      created_at: "2026-09-01T00:00:00Z",
    },
  ],
  golden: [
    {
      id: "t2sg_1",
      name: "월별 매출",
      question: "월별 매출 알려줘",
      expected_sql: "SELECT month, SUM(amount) FROM orders GROUP BY month",
      schema_name: "analytics",
      tags: ["매출"],
      enabled: true,
      source: "manual",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
  logs: [
    {
      id: "t2sl_1",
      request_id: "req_t2s_1",
      api_key_id: "key_1",
      team: "platform",
      virtual_model: "vibe/text2sql-preview",
      upstream_model: "gpt-4o-mini",
      mode: "preview",
      question: "지난달 주문 건수",
      generated_sql: "SELECT COUNT(*) FROM orders",
      schema_name: "analytics",
      schema_version: 3,
      permission_hash: "ph1",
      glossary_hash: "gh1",
      valid: true,
      reject_reason: "",
      executed: false,
      row_count: 0,
      error: "",
      failure_category: "",
      explain_cost: 0,
      explain_risk: 10,
      cost_krw: 12.5,
      generation_cost: 10,
      summary_cost: 2.5,
      latency_ms: 820,
      created_at: "2026-09-06T12:00:00Z",
    },
  ],
  failures: [{ category: "permission_denied", count: 3 }],
  model_metrics: [
    {
      upstream_model: "gpt-4o-mini",
      total: 128,
      valid: 120,
      executed: 42,
      errors: 8,
      valid_rate: 0.9375,
      avg_cost_krw: 25,
      avg_latency_ms: 910,
    },
  ],
  stage_metrics: [
    {
      stage: "generate",
      status: "ok",
      model: "gpt-4o-mini",
      count: 128,
      error_count: 4,
      total_cost_krw: 3000,
      avg_cost_krw: 23,
      avg_latency_ms: 700,
      max_latency_ms: 2400,
      error_rate: 0.03,
    },
  ],
};

const connections = {
  connections: [
    {
      id: "analytics_db",
      name: "분석 DB",
      driver: "postgres",
      description: "읽기 전용 복제본",
      enabled: true,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const emptyOverview = {
  enabled: false,
  stats: { total: 0, valid: 0, executed: 0, errors: 0, cost_krw: 0, valid_rate: 0 },
  profiles: [],
  db_profiles: [],
  schemas: [],
  permissions: [],
  golden: [],
  logs: [],
  failures: [],
  model_metrics: [],
  stage_metrics: [],
};

const shellHandlers = {
  "GET /admin/text2sql": () => overview,
  "GET /admin/text2sql/connections": () => connections,
  "GET /admin/text2sql/kill-switch": () => ({ disabled: false, config_enabled: true }),
} as const;

function renderPage(route = "/text2sql"): ReturnType<typeof renderScreen> {
  return renderScreen(<Text2SqlPage />, { path: "/text2sql", route });
}

describe("Text2SqlPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the summary metrics and the recent query log", async () => {
    mockApi({ ...shellHandlers });
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "Text2SQL" })).toBeVisible();
    expect(await screen.findByText("활성")).toBeVisible();
    const logTable = await screen.findByRole("table", { name: "최근 Text2SQL 질의" });
    expect(within(logTable).getByText("지난달 주문 건수")).toBeVisible();
    expect(within(logTable).getByText("SELECT COUNT(*) FROM orders")).toBeVisible();
    const modelTable = screen.getByRole("table", { name: "모델별 SQL 품질" });
    expect(within(modelTable).getByText("gpt-4o-mini")).toBeVisible();
  });

  it("shows an empty state when nothing has been recorded yet", async () => {
    mockApi({
      ...shellHandlers,
      "GET /admin/text2sql": () => emptyOverview,
      "GET /admin/text2sql/connections": () => ({ connections: [] }),
    });
    renderPage();

    expect(
      await screen.findByText(
        "Text2SQL 질의 기록이 없습니다. 사용자가 vibe/text2sql-preview 모델을 호출하면 집계됩니다.",
      ),
    ).toBeVisible();
  });

  it("shows the request id when the overview request fails", async () => {
    mockApi({
      ...shellHandlers,
      "GET /admin/text2sql": () => {
        throw apiFailure("text2sql store unavailable", 500, "req_t2s_err");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_t2s_err");
  });

  it("disables write actions without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ ...shellHandlers });
    renderPage("/text2sql?tab=golden");

    expect(await screen.findByRole("button", { name: "Golden Query 추가" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "회귀 검증 실행" })).toBeDisabled();
    expect(screen.getByText(/admin:write/u)).toBeVisible();
  });

  it("restores the selected tab and window from the URL", async () => {
    const api = mockApi({
      ...shellHandlers,
      "GET /admin/text2sql/risk-queue": () => ({ count: 0, queue: [] }),
      "GET /admin/text2sql/anomalies": () => ({
        detection_only: true,
        usage_smells: [],
        risk_exposure: [],
        intent_drifts: [],
      }),
    });
    renderPage("/text2sql?tab=risk&window=30d&min_risk=70");

    expect(await screen.findByRole("tab", { name: "위험·이상", selected: true })).toBeVisible();
    expect(await screen.findByRole("table", { name: "Text2SQL 위험 요청 큐" })).toBeVisible();
    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "GET /admin/text2sql/risk-queue")).toBe(true);
    });
    const riskCall = api.calls.find((call) => call.key === "GET /admin/text2sql/risk-queue");
    expect(riskCall?.options.query).toEqual({ window: "30d", min_risk: 70 });
    const overviewCall = api.calls.find((call) => call.key === "GET /admin/text2sql");
    expect(overviewCall?.options.query).toEqual({ window: "30d" });
  });

  it("deletes a golden query after confirmation", async () => {
    const api = mockApi({
      ...shellHandlers,
      "DELETE /admin/text2sql/golden": () => ({ status: "deleted" }),
    });
    const user = userEvent.setup();
    renderPage("/text2sql?tab=golden");

    expect(await screen.findByText("월별 매출")).toBeVisible();
    const table = screen.getByRole("table", { name: "Text2SQL Golden Query" });
    await user.click(within(table).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "DELETE /admin/text2sql/golden")).toBe(true);
    });
    const deleteCall = api.calls.find((call) => call.key === "DELETE /admin/text2sql/golden");
    expect(deleteCall?.options.query).toEqual({ id: "t2sg_1" });
  });

  it("adds a permission rule from the access tab", async () => {
    const api = mockApi({
      ...shellHandlers,
      "GET /admin/text2sql/glossary": () => ({ terms: [], conflicts: [] }),
      "POST /admin/text2sql/permissions": () => ({ status: "ok" }),
    });
    const user = userEvent.setup();
    renderPage("/text2sql?tab=access");

    await user.click(await screen.findByRole("button", { name: "권한 규칙 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/주체 ID/u), "platform");
    await user.type(within(dialog).getByLabelText(/^schema/u), "analytics");
    await user.click(within(dialog).getByRole("button", { name: "추가" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/text2sql/permissions")).toHaveLength(1);
    });
    expect(api.bodies("POST /admin/text2sql/permissions")[0]).toEqual({
      subject_type: "team",
      subject_id: "platform",
      schema_name: "analytics",
      table_name: "",
      column_name: "",
      action: "deny",
    });
  });

  it("runs the execute-database healthcheck only from the button", async () => {
    const api = mockApi({
      ...shellHandlers,
      "GET /admin/text2sql/features": () => ({ features: [] }),
      "GET /admin/text2sql/healthcheck": () => ({
        status: "ok",
        detail: "실행 DB 정상 (read-only 샌드박스 동작)",
        configured: true,
        reachable: true,
        driver: "postgres",
        statement_timeout: "5s",
        connection_id: "analytics_db",
        read_only_tx_ok: true,
        statement_timeout_ok: true,
        account_write_restricted: true,
      }),
    });
    const user = userEvent.setup();
    renderPage("/text2sql?tab=runtime");

    expect(await screen.findByText("분석 DB")).toBeVisible();
    const table = screen.getByRole("table", { name: "Text2SQL 실행 DB 연결" });
    expect(api.calls.some((call) => call.key === "GET /admin/text2sql/healthcheck")).toBe(false);

    await user.click(within(table).getByRole("button", { name: "헬스체크" }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "GET /admin/text2sql/healthcheck")).toBe(true);
    });
    const call = api.calls.find((entry) => entry.key === "GET /admin/text2sql/healthcheck");
    expect(call?.options.query).toEqual({ connection_id: "analytics_db" });
    expect(await screen.findByText("실행 DB 정상 (read-only 샌드박스 동작)")).toBeVisible();
  });

  it("deletes an execute-database connection through the confirmation dialog", async () => {
    const api = mockApi({
      ...shellHandlers,
      "GET /admin/text2sql/features": () => ({ features: [] }),
      "DELETE /admin/text2sql/connections": () => ({ id: "analytics_db", status: "deleted" }),
    });
    const user = userEvent.setup();
    renderPage("/text2sql?tab=runtime");

    expect(await screen.findByText("분석 DB")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "analytics_db 연결 삭제" }));

    const dialog = await screen.findByRole("dialog", { name: "실행 DB 연결 삭제" });
    expect(api.calls.some((call) => call.key === "DELETE /admin/text2sql/connections")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "DELETE /admin/text2sql/connections")).toBe(true);
    });
    const call = api.calls.find((entry) => entry.key === "DELETE /admin/text2sql/connections");
    expect(call?.options.query).toEqual({ id: "analytics_db" });
  });

  it("disables the connection delete button without write scope", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ ...shellHandlers, "GET /admin/text2sql/features": () => ({ features: [] }) });
    renderPage("/text2sql?tab=runtime");

    expect(await screen.findByText("분석 DB")).toBeVisible();
    expect(screen.getByRole("button", { name: "analytics_db 연결 삭제" })).toBeDisabled();
  });

  it("has no accessibility violations", async () => {
    mockApi({ ...shellHandlers });
    const { container } = renderPage();

    await screen.findByRole("table", { name: "최근 Text2SQL 질의" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
