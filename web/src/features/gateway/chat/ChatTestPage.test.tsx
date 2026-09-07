import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatTestPage } from "@/features/gateway/chat/ChatTestPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write", "routing:read"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const targetsFixture = {
  targets: [
    {
      id: "routing:vibe/auto",
      kind: "routing",
      label: "vibe/auto · Intelligent Router",
      model: "vibe/auto",
      enabled: true,
      description: "자동 라우팅",
      metadata: {},
    },
  ],
  grouped: {
    routing: [
      {
        id: "routing:vibe/auto",
        kind: "routing",
        label: "vibe/auto · Intelligent Router",
        model: "vibe/auto",
        enabled: true,
        metadata: {},
      },
    ],
    provider: [
      {
        id: "provider:openai:gpt-*",
        kind: "provider_pattern",
        label: "openai · gpt-*",
        model: "gpt-",
        provider: "openai",
        pattern: "gpt-*",
        enabled: true,
        metadata: {},
      },
    ],
  },
  defaults: { model: "vibe/auto", prompt: "ping", max_tokens: 4096, temperature: 0 },
  mcp_fetched_at: "2026-09-01T00:00:00Z",
  mcp_errors: [],
};

const tagsFixture = {
  tags: [
    {
      model: "gpt-4.1",
      good_for: "code_review",
      avoid_for: "sql",
      risk_note: "긴 컨텍스트에서 비용 급증",
      updated_by: "admin",
      updated_at: "2026-09-01T09:00:00Z",
    },
  ],
};

function sseResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Proxy-Provider": "openai" },
  });
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write", "routing:read"];
});

function renderChat(route = "/gateway/chat") {
  return renderScreen(<ChatTestPage />, { path: "/gateway/chat", route });
}

describe("ChatTestPage", () => {
  it("shows the call form with the target catalogue", async () => {
    mockApi({ "GET /admin/chat-test/targets": () => targetsFixture });
    renderChat();

    expect(await screen.findByRole("heading", { name: "Chat 테스트", level: 1 })).toBeInTheDocument();
    const targetSelect = await screen.findByLabelText("테스트 대상");
    expect(within(targetSelect).getByRole("option", { name: /Intelligent Router/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chat 호출/ })).toBeEnabled();
    expect(screen.getByText(/아직 호출한 응답이 없습니다/)).toBeInTheDocument();
  });

  it("streams a response and keeps the prompt out of the URL", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /admin/chat-test/targets": () => targetsFixture });
    const fetchMock = vi.fn(async () => sseResponse([chunk("안녕"), chunk("하세요"), "data: [DONE]\n\n"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    renderChat();
    const prompt = await screen.findByLabelText(/^프롬프트/);
    await user.clear(prompt);
    await user.type(prompt, "핑");
    await user.click(screen.getByRole("button", { name: /Chat 호출/ }));

    expect(await screen.findByText("안녕하세요")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/admin/chat-test/stream");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "vibe/auto",
      messages: [{ role: "user", content: "핑" }],
    });
    expect(window.location.search).not.toContain("핑");
  });

  it("surfaces a streaming failure with its request id", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /admin/chat-test/targets": () => targetsFixture });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "모델 호출이 거부되었습니다." } }), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-Request-ID": "req_chat_1" },
        }),
    ) as unknown as typeof globalThis.fetch;

    renderChat();
    await screen.findByLabelText(/^프롬프트/);
    await user.click(screen.getByRole("button", { name: /Chat 호출/ }));

    const alert = await screen.findByRole("alert");
    // Upstream messages are replaced by an operational message; the request ID stays.
    expect(alert).toHaveTextContent("권한이 없습니다");
    expect(alert).toHaveTextContent("req_chat_1");
  });

  it("disables the call when the operator cannot write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ "GET /admin/chat-test/targets": () => targetsFixture });
    renderChat();

    expect(await screen.findByRole("button", { name: /Chat 호출/ })).toBeDisabled();
    expect(screen.getByText(/admin:write 권한이 필요합니다/)).toBeInTheDocument();
  });

  it("restores the selected tab from the URL and runs a comparison", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/chat-test/multi-run/runs": () => ({ runs: [] }),
      "POST /admin/chat-test/multi-run": () => ({
        status: "completed",
        run_id: "mmt_1",
        summary: { total_models: 1, success: 1, failed: 0, best_latency_model: "gpt-4.1" },
        results: [
          {
            model: "gpt-4.1",
            provider: "openai",
            status: "success",
            latency_ms: 812,
            input_tokens: 12,
            output_tokens: 44,
            cost_krw_est: 3.2,
            content: "비교 응답",
          },
        ],
      }),
    });

    renderChat("/gateway/chat?tab=compare");

    const models = await screen.findByLabelText(/^비교할 모델/);
    await user.clear(models);
    await user.type(models, "gpt-4.1:openai");
    await user.type(screen.getByLabelText(/^User 프롬프트/), "요약해줘");
    await user.click(screen.getByRole("button", { name: /멀티 실행/ }));

    expect(await screen.findByText("비교 응답")).toBeInTheDocument();
    expect(api.bodies("POST /admin/chat-test/multi-run")[0]).toMatchObject({
      models: [{ model: "gpt-4.1", provider: "openai" }],
      save_prompt: false,
    });
  });

  it("creates a model usage tag and invalidates the list", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/model-tags": () => tagsFixture,
      "POST /admin/model-tags": () => ({ model: "claude-4", good_for: "sql" }),
    });

    renderChat("/gateway/chat?tab=tags");

    expect(await screen.findByText("gpt-4.1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /태그 추가/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^모델/), "claude-4");
    await user.type(within(dialog).getByLabelText("적합한 작업"), "sql");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/model-tags")[0]).toMatchObject({
        model: "claude-4",
        good_for: "sql",
      });
    });
  });

  it("keeps the tag list usable when the request fails", async () => {
    mockApi({ "GET /admin/model-tags": () => Promise.reject(apiFailure("upstream down", 500, "req_tag")) });
    renderChat("/gateway/chat?tab=tags");

    expect(await screen.findByText(/모델 용도 태그를 불러오지 못했습니다/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    mockApi({ "GET /admin/chat-test/targets": () => targetsFixture });
    const { container } = renderChat();

    await screen.findByLabelText(/^프롬프트/);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
