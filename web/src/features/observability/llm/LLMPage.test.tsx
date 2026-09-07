import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLMPage } from "@/features/observability/llm/LLMPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const timeseries = {
  window: "24h",
  bucket: "hour",
  since: "2026-09-06T00:00:00Z",
  points: [
    {
      date: "2026-09-06T00:00:00Z",
      bucket: "hour",
      requests: 40,
      tokens: 5000,
      cost_krw: 300,
      errors: 2,
      average_first_chunk_ms: 250,
      evaluation_failures: 1,
      feedback_total: 3,
      negative_feedback: 1,
      alignment_samples: 3,
      alignment_rate: 0.66,
    },
    {
      date: "2026-09-06T01:00:00Z",
      bucket: "hour",
      requests: 55,
      tokens: 6100,
      cost_krw: 410,
      errors: 0,
      average_first_chunk_ms: 210,
      evaluation_failures: 0,
      feedback_total: 2,
      negative_feedback: 0,
      alignment_samples: 2,
      alignment_rate: 1,
    },
  ],
};

const evaluations = {
  summary: [{ name: "code_quality", category: "llm", total: 20, passed: 17, failed: 3, average_score: 0.82 }],
  evaluations: [
    {
      id: "eval-1",
      request_id: "req-1",
      trace_id: "trace-1",
      name: "code_quality",
      category: "llm",
      evaluator: "judge",
      score: 0.31,
      label: "fail",
      passed: false,
      reason: "테스트가 없습니다",
      created_at: "2026-09-06T01:00:00Z",
    },
  ],
};

const feedback = {
  summary: { total: 5, positive: 3, negative: 2, neutral: 0, average_rating: 0.2 },
  feedback: [
    {
      id: "fb-1",
      request_id: "req-1",
      trace_id: "trace-1",
      rating: -1,
      label: "hallucination",
      comment: "없는 API를 만들어냈습니다",
      source: "console",
      created_by: "operator@example.com",
      created_at: "2026-09-06T01:10:00Z",
    },
  ],
  labels: [{ label: "hallucination", total: 2, positive: 0, negative: 2, neutral: 0, average_rating: -1 }],
  prompts: [{ prompt_name: "review", prompt_version: "v3", total: 5, positive: 3, negative: 2 }],
  alignment: { total: 5, aligned: 3, misaligned: 2, alignment_rate: 0.6, human_negative_count: 2 },
  alignment_prompts: [
    {
      prompt_name: "review",
      prompt_version: "v3",
      total: 5,
      aligned: 3,
      misaligned: 2,
      alignment_rate: 0.6,
      human_negative: 2,
      eval_failure_rate: 0.15,
      last_seen: "2026-09-06T01:10:00Z",
    },
  ],
};

const prompts = {
  prompts: [
    {
      prompt_name: "review",
      prompt_version: "v3",
      calls: 120,
      tokens: 24000,
      cost_krw: 1800,
      average_latency_ms: 900,
      errors: 3,
      eval_failures: 4,
      first_seen: "2026-09-01T00:00:00Z",
      last_seen: "2026-09-06T01:00:00Z",
    },
  ],
};

const insights = {
  window: "24h",
  since: "2026-09-06T00:00:00Z",
  insights: [
    {
      id: "ins-1",
      severity: "high",
      kind: "quality",
      title: "review 프롬프트 평가 실패 증가",
      detail: "최근 24시간 실패율 15%",
      scope: "prompt",
      scope_value: "review",
      count: 4,
      metric_value: 0.15,
      recommendation: "v2로 롤백을 검토하세요.",
      last_seen: "2026-09-06T01:00:00Z",
    },
  ],
};

const traceDetail = {
  request: {
    id: "req-1",
    trace_id: "trace-1",
    api_key_id: "key-1",
    model: "gpt-test",
    provider: "openai",
    endpoint: "/v1/chat/completions",
    status_code: 200,
    latency_ms: 900,
    first_chunk_ms: 200,
    session_id: "sess-alpha",
    prompt_name: "review",
    prompt_version: "v3",
    tool_count: 1,
    error: "",
    total_tokens: 1200,
    estimated_cost: 90,
    finish_reason: "stop",
    created_at: "2026-09-06T01:00:00Z",
  },
  spans: [],
  evaluations: evaluations.evaluations,
  feedback: feedback.feedback,
  tools: [
    {
      id: "tool-1",
      request_id: "req-1",
      server_label: "github",
      tool_name: "create_pull_request",
      source: "call",
      is_mcp: true,
      is_error: false,
      arg_sensitive: false,
      arg_hash: "ab12cd",
      created_at: "2026-09-06T01:00:01Z",
    },
  ],
  code_verify: {
    risk: "medium",
    has_code: true,
    block_count: 2,
    languages: "typescript",
    high_count: 0,
    medium_count: 1,
    syntax_count: 0,
    secret_count: 0,
    testable_count: 2,
    created_at: "2026-09-06T01:00:02Z",
  },
};

const baseHandlers = {
  "GET /admin/llm/timeseries": () => timeseries,
  "GET /admin/llm/evaluations": () => evaluations,
  "GET /admin/llm/feedback": () => feedback,
  "GET /admin/llm/prompts": () => prompts,
  "GET /admin/llm/insights": () => insights,
  "GET /admin/llm/patterns": () => ({ patterns: [] }),
};

function renderPage(route = "/observability/llm"): ReturnType<typeof renderScreen> {
  return renderScreen(<LLMPage />, { path: "/observability/llm", route });
}

describe("LLMPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the summary KPIs and trend charts", async () => {
    mockApi(baseHandlers);
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "LLM 관측" })).toBeVisible();
    const summary = await screen.findByRole("region", { name: "LLM 요약" });
    expect(within(summary).getByText("20")).toBeVisible();
    expect(await screen.findByRole("img", { name: "구간별 요청 수와 오류 수" })).toBeVisible();
  });

  it("restores the evaluations tab from the URL", async () => {
    mockApi(baseHandlers);
    renderPage("/observability/llm?tab=evaluations");

    const table = await screen.findByRole("table", { name: "최근 평가 결과" });
    expect(await within(table).findByText("테스트가 없습니다")).toBeVisible();
  });

  it("shows an empty state when there is no feedback yet", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/llm/feedback": () => ({ ...feedback, feedback: [], alignment_prompts: [] }),
    });
    renderPage("/observability/llm?tab=feedback");

    expect(await screen.findByText("등록된 피드백이 없습니다.")).toBeVisible();
  });

  it("shows the request id when every panel fails", async () => {
    const failing = () => {
      throw apiFailure("llm store unavailable", 500, "req_llm_1");
    };
    mockApi({
      ...baseHandlers,
      ...Object.fromEntries(Object.keys(baseHandlers).map((key) => [key, failing])),
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_llm_1");
  });

  it("disables the feedback composer without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(baseHandlers);
    renderPage("/observability/llm?tab=feedback");

    expect(await screen.findByRole("button", { name: /피드백 남기기/u })).toBeDisabled();
  });

  it("opens a trace detail with tool calls and code verification", async () => {
    const user = userEvent.setup();
    mockApi({ ...baseHandlers, "GET /admin/llm/traces/req-1": () => traceDetail });
    renderPage("/observability/llm?tab=evaluations");

    await user.click(await screen.findByRole("button", { name: "req-1 호출 상세 열기" }));

    expect(await screen.findByRole("table", { name: "이 호출에서 사용한 도구" })).toBeVisible();
    expect(screen.getByText("create_pull_request")).toBeVisible();
    expect(screen.getByText("위험도 medium")).toBeVisible();
  });

  it("loads the request explanation only after the operator opens it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/llm/traces/req-1": () => traceDetail,
      "GET /admin/requests/req-1/explain": () => ({
        request_id: "req-1",
        trace_id: "trace-1",
        created_at: "2026-09-06T01:00:00Z",
        routing: {
          chosen_provider: "openai",
          chosen_model: "gpt-test",
          reason: "default",
          reason_text: "기본 provider",
          risk_categories: [],
          fallback_path: [],
        },
        fallback: { occurred: false },
        cache: { hit: false, cached_tokens: 0 },
        safety: { blocked: false, masking: "", finding_count: 0, findings: [] },
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
          priced: false,
        },
        session: { session_id: "", stream: false },
      }),
      "GET /admin/requests/req-1/note": () => ({ request_id: "req-1", tags: [], note: "" }),
    });
    renderPage("/observability/llm?tab=evaluations");

    await user.click(await screen.findByRole("button", { name: "req-1 호출 상세 열기" }));
    await screen.findByRole("table", { name: "이 호출에서 사용한 도구" });
    expect(api.calls.some((call) => call.key === "GET /admin/requests/req-1/explain")).toBe(false);

    await user.click(screen.getByRole("button", { name: "원인 설명 열기" }));

    expect(await screen.findByText("기본 provider")).toBeVisible();
    expect(api.calls.some((call) => call.key === "GET /admin/requests/req-1/explain")).toBe(true);
  });

  it("submits feedback with the operator's rating", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "POST /admin/llm/feedback": () => ({ feedback: { ...feedback.feedback[0], id: "fb-2" } }),
    });
    renderPage("/observability/llm?tab=feedback");

    await user.click(await screen.findByRole("button", { name: /피드백 남기기/u }));
    await user.type(await screen.findByLabelText(/요청 ID/u), "req-1");
    await user.selectOptions(screen.getByLabelText(/평점/u), "-1");
    await user.type(screen.getByLabelText(/의견/u), "근거가 없습니다");
    await user.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/llm/feedback")).toEqual([
        { request_id: "req-1", rating: -1, comment: "근거가 없습니다", source: "console" },
      ]);
    });
  });

  it("has no automated accessibility violations", async () => {
    mockApi(baseHandlers);
    const { container } = renderPage("/observability/llm?tab=evaluations");

    await screen.findByRole("table", { name: "최근 평가 결과" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
