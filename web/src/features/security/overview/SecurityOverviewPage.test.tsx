import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityOverviewPage } from "@/features/security/overview/SecurityOverviewPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "security:read", "costs:read"] as string[],
}));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const dashboard = {
  since: "2026-09-01T00:00:00Z",
  policy: {
    by_decision: { allow: 40, block: 3, warn: 2 },
    blocked: 3,
    warned: 2,
    recent: [
      {
        decision: "block",
        reason: "사내 비밀정보 전송 시도",
        rule: "secret-egress",
        endpoint: "/v1/chat/completions",
        risk_score: 88,
        created_at: "2026-09-06T23:50:00Z",
      },
    ],
  },
  secrets: { total: 5, by_type: { aws_access_key: 3, jwt: 2 } },
  mcp_summary: { total_calls: 120, total_errors: 4, distinct_tools: 9, mcp_servers: 2 },
  risky_tools: [
    {
      id: "trp_1",
      server_label: "internal-tools",
      tool_name: "shell.exec",
      risk_level: "critical",
      action: "block",
      note: "",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
  pending_approvals: [
    {
      id: "apr_1",
      subject_type: "tool",
      subject_id: "shell.exec",
      status: "pending",
      reason: "운영 서버 점검",
      risk_score: 70,
      created_at: "2026-09-06T22:00:00Z",
    },
  ],
  pending_count: 1,
};

const emptyDashboard = {
  since: "2026-09-01T00:00:00Z",
  policy: { by_decision: {}, blocked: 0, warned: 0, recent: [] },
  secrets: { total: 0, by_type: {} },
  mcp_summary: { total_calls: 0, total_errors: 0, distinct_tools: 0, mcp_servers: 0 },
  risky_tools: [],
  pending_approvals: null,
  pending_count: 0,
};

const secretEvents = {
  secret_events: [
    {
      id: "sev_1",
      request_id: "req_abcdef123456789",
      api_key_id: "key_1",
      user_id: "usr_1",
      team_id: "platform",
      secret_type: "aws_access_key",
      action: "block",
      location: "prompt",
      matched_hash: "9f2c",
      created_at: "2026-09-06T23:00:00Z",
    },
  ],
  count: 1,
  filters: { limit: 200, since: "2026-08-31T00:00:00Z" },
};

const anomalies = {
  anomalies: [
    {
      model: "gpt-4.1",
      metric: "latency_ms",
      baseline_mean: 800,
      baseline_std: 60,
      recent_mean: 1900,
      z_score: 4.2,
      direction: "up",
      baseline_samples: 400,
      recent_samples: 30,
    },
  ],
  cost_anomalies: [],
  detected_events: [],
  inserted_events: [],
  events: [],
  alerts: { enabled: false, webhook_url: "", slack_webhook_url: "" },
  z_threshold: 3,
};

const privacyLedger = {
  dimension: "model",
  days: 7,
  rows: [
    {
      dim_value: "gpt-4.1",
      detections: 12,
      masked: 7,
      blocked: 2,
      egress_requests: 340,
      egress_tokens: 91_000,
    },
  ],
  totals: { detections: 12, masked: 7, blocked: 2, egress_requests: 340, egress_tokens: 91_000 },
  note: "원문은 포함되지 않습니다.",
};

const auditPayloads = {
  events: [
    {
      id: "ae_1",
      event_type: "login_failed",
      actor_user_id: "usr_9",
      api_key_id: "",
      team_id: "platform",
      ip: "10.0.0.9",
      user_agent: "curl/8",
      detail: "bad password",
      created_at: "2026-09-06T21:00:00Z",
    },
  ],
};

const adminAudit = {
  audit_logs: [
    {
      id: "al_1",
      admin_id: "usr_1",
      action: "policy_update",
      before_value: "warn",
      after_value: "block",
      created_at: "2026-09-06T20:00:00Z",
    },
  ],
};

function handlers(overrides: Record<string, () => unknown> = {}): Record<string, () => unknown> {
  return {
    "GET /security/dashboard": () => dashboard,
    "GET /admin/security/secrets": () => secretEvents,
    "GET /admin/anomalies": () => anomalies,
    "GET /admin/privacy-ledger": () => privacyLedger,
    "GET /admin/audit/auth-events": () => auditPayloads,
    "GET /admin/audit-logs": () => adminAudit,
    ...overrides,
  };
}

function renderPage(route = "/security"): ReturnType<typeof renderScreen> {
  return renderScreen(<SecurityOverviewPage />, { path: "/security/*", route });
}

describe("SecurityOverviewPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write", "security:read", "costs:read"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("보안 대시보드 지표와 위험 신호를 보여준다", async () => {
    mockApi(handlers());
    renderPage();

    expect(await screen.findByText("사내 비밀정보 전송 시도")).toBeVisible();
    const stats = screen.getByRole("region", { name: "보안 핵심 지표" });
    expect(within(stats).getByText("차단(정책)").parentElement?.parentElement).toHaveTextContent("3");
    expect(screen.getByRole("table", { name: "위험 MCP 도구" })).toHaveTextContent("shell.exec");
    expect(screen.getByRole("table", { name: "승인 대기 큐" })).toHaveTextContent("운영 서버 점검");
    expect(screen.getByText("aws_access_key")).toBeVisible();
    expect(screen.getByText("기존 화면에서 열기")).toHaveAttribute("href", "/admin#/security");
  });

  it("데이터가 없으면 무엇이 채워지는지 안내한다", async () => {
    mockApi(handlers({ "GET /security/dashboard": () => emptyDashboard }));
    renderPage();

    expect(await screen.findByText("탐지된 Secret이 없습니다.")).toBeVisible();
    expect(screen.getByText("최근 위반이 없습니다.")).toBeVisible();
    expect(screen.getByText("high/critical 도구가 없습니다.")).toBeVisible();
    expect(screen.getByText("대기 중인 승인이 없습니다.")).toBeVisible();
  });

  it("조회 실패 시 요청 ID와 재시도를 보여준다", async () => {
    mockApi(
      handlers({
        "GET /security/dashboard": () => {
          throw apiFailure("보안 대시보드를 조회할 수 없습니다.", 503, "req-sec-1");
        },
      }),
    );
    renderPage();

    expect(await screen.findByText("요청 ID: req-sec-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "보안 대시보드 재시도" })).toBeVisible();
  });

  it("권한이 없으면 필요한 권한을 안내한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(handlers());
    renderPage();

    expect(await screen.findByText("보안 대시보드를 볼 권한이 없습니다.")).toBeVisible();
    expect(screen.getByText("security:read")).toBeVisible();
  });

  it("URL의 탭과 필터를 복원하고 원장을 조회한다", async () => {
    const api = mockApi(handlers());
    renderPage("/security?tab=privacy&dimension=model&days=7");

    expect(await screen.findByRole("table", { name: "프라이버시 원장" })).toHaveTextContent("gpt-4.1");
    expect(api.calls.find((call) => call.key === "GET /admin/privacy-ledger")?.options.query).toEqual({
      dimension: "model",
      days: 7,
    });
    expect(screen.getByLabelText("차원")).toHaveValue("model");
  });

  it("이상 탐지 조회는 서버에 기록을 남기지 않는다", async () => {
    const api = mockApi(handlers());
    renderPage("/security?tab=anomalies");

    expect(await screen.findByRole("table", { name: "모델 지표 이상" })).toHaveTextContent("gpt-4.1");
    expect(api.calls.find((call) => call.key === "GET /admin/anomalies")?.options.query).toMatchObject({
      record: "0",
    });
  });

  it("비밀정보 탐지에서 조치 필터와 상세 패널이 동작한다", async () => {
    const api = mockApi(handlers());
    const user = userEvent.setup();
    renderPage("/security?tab=secrets");

    expect(await screen.findByRole("table", { name: "비밀정보 탐지 기록" })).toHaveTextContent(
      "aws_access_key",
    );
    await user.selectOptions(screen.getByLabelText("조치"), "block");
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.key === "GET /admin/security/secrets").at(-1)?.options.query,
      ).toMatchObject({ action: "block" }),
    );

    await user.click(screen.getByRole("button", { name: "aws_access_key 탐지 상세 보기" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("9f2c")).toBeVisible();
  });

  it("인증 이벤트와 관리자 감사 로그를 함께 보여준다", async () => {
    mockApi(handlers());
    renderPage("/security?tab=audit");

    expect(await screen.findByRole("table", { name: "인증 이벤트" })).toHaveTextContent("login_failed");
    expect(screen.getByRole("table", { name: "관리자 감사 로그" })).toHaveTextContent("policy_update");
  });

  it("프라이버시 원장 CSV를 인증 헤더와 함께 내려받는다", async () => {
    mockApi(handlers());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("team,detections\n", { status: 200, headers: { "Content-Type": "text/csv" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:csv");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPage("/security?tab=privacy");

    await screen.findByRole("table", { name: "프라이버시 원장" });
    await user.click(screen.getByRole("button", { name: /CSV 내보내기/ }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/admin/privacy-ledger?dimension=team&days=30&format=csv");
    expect((init.headers as Record<string, string>)["X-Vibe-UI"]).toBe("app");
    vi.unstubAllGlobals();
  });

  it("접근성 위반이 없다", async () => {
    mockApi(handlers());
    const { container } = renderPage();

    await screen.findByRole("table", { name: "위험 MCP 도구" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
