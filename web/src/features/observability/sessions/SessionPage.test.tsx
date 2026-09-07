import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionPage } from "@/features/observability/sessions/SessionPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const sessionsResponse = {
  days: 7,
  sessions: [
    {
      session_id: "sess-alpha",
      requests: 12,
      first_seen: "2026-09-06T01:00:00Z",
      last_seen: "2026-09-06T02:30:00Z",
      models: 2,
      api_keys: 1,
      errors: 1,
      total_tokens: 4200,
      cost_krw: 380,
      last_message: "리팩터링 도와줘",
    },
  ],
  note: "최근 코딩 세션을 활동순으로 보여줍니다.",
};

const flightRecorderResponse = {
  session_id: "sess-alpha",
  events: [
    {
      request_id: "req-1",
      trace_id: "trace-1",
      kind: "chat",
      endpoint: "/v1/chat/completions",
      model: "gpt-test",
      provider: "openai",
      status_code: 200,
      is_error: false,
      latency_ms: 820,
      total_tokens: 1200,
      cost_krw: 90,
      tool_count: 1,
      created_at: "2026-09-06T01:00:00Z",
      last_message: "리팩터링 도와줘",
    },
    {
      request_id: "req-2",
      trace_id: "trace-2",
      kind: "chat",
      endpoint: "/v1/chat/completions",
      model: "gpt-test",
      provider: "openai",
      status_code: 500,
      is_error: true,
      latency_ms: 4200,
      total_tokens: 300,
      cost_krw: 20,
      tool_count: 0,
      created_at: "2026-09-06T01:05:00Z",
      last_message: "",
      secret_events: 1,
      policy_blocks: 1,
      code_risk: "high",
    },
  ],
  summary: {
    verdict: "위험",
    headline: "2건 요청 · 모델 1종 · 오류율 50%",
    findings: ["1건 요청이 오류(HTTP 4xx/5xx)로 종료됨", "1개 요청에서 시크릿이 탐지/마스킹됨"],
  },
  rollup: {
    requests: 2,
    started_at: "2026-09-06T01:00:00Z",
    ended_at: "2026-09-06T01:05:00Z",
    models: ["gpt-test"],
    providers: ["openai"],
    trace_ids: ["trace-1", "trace-2"],
    kinds: { chat: 2 },
    total_tokens: 1500,
    total_cost: 110,
    errors: 1,
    tool_calls: 1,
    risk: { secret_requests: 1, policy_block_requests: 1, high_risk_code_requests: 1 },
  },
  note: "한 세션의 게이트웨이 요청을 시간순으로 재구성한 비행기록입니다.",
};

function renderPage(route = "/observability/sessions"): ReturnType<typeof renderScreen> {
  return renderScreen(<SessionPage />, { path: "/observability/sessions", route });
}

describe("SessionPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("lists recent sessions with their key values", async () => {
    mockApi({ "GET /admin/sessions": () => sessionsResponse });
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "세션 비행기록" })).toBeVisible();
    const table = await screen.findByRole("table", { name: "최근 코딩 세션" });
    expect(await within(table).findByText("sess-alpha")).toBeVisible();
    expect(within(table).getByText("리팩터링 도와줘")).toBeVisible();
  });

  it("shows an empty state when no session was recorded", async () => {
    mockApi({ "GET /admin/sessions": () => ({ days: 7, sessions: [], note: "" }) });
    renderPage();

    expect(await screen.findByText("표시할 세션이 없습니다.")).toBeVisible();
  });

  it("shows the request id when the session list fails", async () => {
    mockApi({
      "GET /admin/sessions": () => {
        throw apiFailure("session store unavailable", 500, "req_sess_1");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_sess_1");
  });

  it("restores the day filter from the URL and sends it to the server", async () => {
    const api = mockApi({ "GET /admin/sessions": () => ({ ...sessionsResponse, days: 30 }) });
    renderPage("/observability/sessions?days=30");

    await screen.findByRole("table", { name: "최근 코딩 세션" });
    await waitFor(() => {
      expect(api.calls.at(0)?.options.query).toEqual({ days: 30 });
    });
    expect(screen.getByLabelText("조회 기간(일)")).toHaveValue(30);
  });

  it("opens the flight recorder for a session and exposes its risk timeline", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/sessions": () => sessionsResponse,
      "GET /admin/sessions/sess-alpha/flight-recorder": () => flightRecorderResponse,
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "sess-alpha 세션 비행기록 열기" }));

    expect(await screen.findByText("판정: 위험")).toBeVisible();
    expect(screen.getByText("1개 요청에서 시크릿이 탐지/마스킹됨")).toBeVisible();
    expect(screen.getByText("정책 차단 1")).toBeVisible();
    expect(screen.getByText("코드 위험 high")).toBeVisible();
  });

  it("keeps a credential-shaped search out of the URL", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /admin/sessions": () => sessionsResponse });
    renderPage();

    await user.type(await screen.findByLabelText("세션 ID · 메시지 검색"), "Bearer abcdefghijklmnop");
    await user.click(screen.getByRole("button", { name: /조회/u }));

    expect(await screen.findByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
  });

  it("has no automated accessibility violations", async () => {
    mockApi({ "GET /admin/sessions": () => sessionsResponse });
    const { container } = renderPage();

    await screen.findByRole("table", { name: "최근 코딩 세션" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
