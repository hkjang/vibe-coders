import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestInsightPanel } from "@/features/observability/request-insight/RequestInsightPanel";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

// The route guard reads auth even though the panel itself takes permissions as props.
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

// Shaped like handleRequestExplain in internal/proxy/admin_explain.go.
const explain = {
  request_id: "req-1",
  trace_id: "trace-1",
  created_at: "2026-09-06T01:00:00Z",
  routing: {
    chosen_provider: "openai",
    chosen_model: "gpt-4o-mini",
    requested_model: "gpt-4o",
    model_changed: true,
    reason: "complexity_rule",
    reason_text: "복잡도 기반 비용 최적 라우팅 규칙",
    detail: "complexity<40 → cheap tier",
    complexity: 22,
    tier: "simple",
    risk_score: 5,
    risk_tier: "low",
    risk_categories: ["none"],
    health_score: 95,
    decision_reason: "upstream latency budget",
    fallback_path: ["openai", "azure"],
    endpoint: "/v1/chat/completions",
  },
  fallback: { occurred: false },
  cache: { hit: false, cached_tokens: 0 },
  safety: {
    blocked: false,
    masking: "프롬프트/응답에 마스킹 규칙 적용",
    finding_count: 1,
    findings: [{ name: "tools.sql", label: "warn", reason: "넓은 도구 권한", category: "safety" }],
  },
  governance: {
    secret_event_count: 0,
    secret_actions: {},
    approval_count: 0,
    approval_status: "",
    anomaly_event_count: 0,
    policy_decision_count: 0,
    policy_decision_total: 0,
  },
  text2sql: { span_count: 0, status: "none", total_latency_ms: 0, total_cost_krw: 0 },
  cost: {
    actual_krw: 90,
    currency: "KRW",
    token_source: "usage",
    prompt_tokens: 800,
    completion_tokens: 400,
    cached_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1200,
    list_krw: 140,
    savings_krw: 50,
    priced: true,
  },
  session: { session_id: "sess-1", stream: true },
};

const note = {
  request_id: "req-1",
  tags: ["지연"],
  note: "재현 필요",
  created_by: "operator@example.com",
  updated_at: "2026-09-06T02:00:00Z",
};

const baseHandlers = {
  "GET /admin/requests/req-1/explain": () => explain,
  "GET /admin/requests/req-1/note": () => note,
};

function renderPanel(overrides: { canInspectRaw?: boolean; canWriteNote?: boolean } = {}) {
  return renderScreen(
    <RequestInsightPanel
      requestId="req-1"
      canInspectRaw={overrides.canInspectRaw ?? true}
      canWriteNote={overrides.canWriteNote ?? true}
    />,
  );
}

beforeEach(() => {
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

describe("RequestInsightPanel", () => {
  it("explains why the request was routed and priced the way it was", async () => {
    mockApi(baseHandlers);
    renderPanel();

    expect(await screen.findByText("복잡도 기반 비용 최적 라우팅 규칙")).toBeVisible();
    expect(screen.getByText("gpt-4o → gpt-4o-mini")).toBeVisible();
    expect(screen.getByText("폴백 없음")).toBeVisible();
    expect(screen.getByText("안전 지적 1건")).toBeVisible();
    const findings = screen.getByRole("table", { name: "이 요청의 안전·거버넌스 지적" });
    expect(within(findings).getByText("tools.sql")).toBeVisible();
  });

  it("keeps the routing originals behind an explicit disclosure", async () => {
    mockApi(baseHandlers);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("복잡도 기반 비용 최적 라우팅 규칙");
    const disclosure = screen.getByText("라우팅 판단 원문 보기");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");

    await user.click(disclosure);
    expect(disclosure.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("complexity<40 → cheap tier")).toBeVisible();
  });

  it("shows the explain failure with its request ID", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/requests/req-1/explain": () => {
        throw apiFailure("request explanation could not be loaded", 500, "req_abc");
      },
    });
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("원인 설명을 불러오지 못했습니다.")).toBeVisible();
    expect(within(alert).getByText(/요청 ID: req_abc/u)).toBeVisible();
  });

  it("saves the operator note with its cleaned tags", async () => {
    const api = mockApi({ ...baseHandlers, "PUT /admin/requests/req-1/note": () => note });
    const user = userEvent.setup();
    renderPanel();

    const tags = await screen.findByLabelText(/^태그/u);
    await waitFor(() => expect(tags).toHaveValue("지연"));
    await user.clear(tags);
    await user.type(tags, "지연, 재현필요");
    await user.click(screen.getByRole("button", { name: "메모 저장" }));

    await waitFor(() => {
      expect(api.bodies("PUT /admin/requests/req-1/note")).toEqual([
        { tags: ["지연", "재현필요"], note: "재현 필요" },
      ]);
    });
    expect(toastSpy.success).toHaveBeenCalledWith("요청 메모를 저장했습니다.");
  });

  it("deletes the operator note", async () => {
    const api = mockApi({
      ...baseHandlers,
      "DELETE /admin/requests/req-1/note": () => ({ id: "req-1", status: "deleted" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "메모 삭제" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "DELETE /admin/requests/req-1/note")).toBe(true);
    });
    expect(toastSpy.success).toHaveBeenCalledWith("요청 메모를 삭제했습니다.");
  });

  it("keeps the model analysis behind a disclosure the operator opens", async () => {
    const api = mockApi({
      ...baseHandlers,
      "POST /admin/requests/req-1/analyze": () => ({ analysis: "1) 의도 2) 결과 3) 오류 없음" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "분석 실행" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "POST /admin/requests/req-1/analyze")).toBe(true);
    });
    const summary = await screen.findByText("분석 결과 펼치기");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(screen.getByLabelText("요청 분석 결과")).toHaveTextContent("1) 의도 2) 결과 3) 오류 없음");
  });

  it("replays only after the danger confirmation and hides the raw answer", async () => {
    const api = mockApi({
      ...baseHandlers,
      "POST /admin/requests/req-1/replay": () => ({ id: "chatcmpl-9", object: "chat.completion" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "재실행" }));
    const dialog = await screen.findByRole("dialog", { name: "이 요청을 다시 실행할까요?" });
    expect(api.calls.some((call) => call.key === "POST /admin/requests/req-1/replay")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "재실행" }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "POST /admin/requests/req-1/replay")).toBe(true);
    });

    const summary = await screen.findByText("재실행 응답 펼치기");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(screen.getByLabelText("재실행 응답 원문")).toHaveTextContent("chatcmpl-9");
  });

  it("disables the raw-prompt actions when the operator may not read originals", async () => {
    mockApi(baseHandlers);
    renderPanel({ canInspectRaw: false });

    expect(await screen.findByRole("button", { name: "분석 실행" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "재실행" })).toBeDisabled();
    expect(screen.getAllByText(/프롬프트 원문 열람 권한.*필요합니다/u).length).toBeGreaterThan(0);
  });

  it("disables note editing without admin:write", async () => {
    mockApi(baseHandlers);
    renderPanel({ canWriteNote: false });

    expect(await screen.findByRole("button", { name: "메모 저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "메모 삭제" })).toBeDisabled();
    expect(screen.getByText("요청 메모 작성에는 admin:write 권한이 필요합니다.")).toBeVisible();
  });

  it("has no accessibility violations", async () => {
    mockApi(baseHandlers);
    const { container } = renderPanel();

    await screen.findByText("복잡도 기반 비용 최적 라우팅 규칙");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
