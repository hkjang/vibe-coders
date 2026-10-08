import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/app/providers/query-client";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { LLMPage } from "./LLMPage";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const id = "public-recovery-request";
const detailPath = `/admin/llm/traces/${id}`;
const notePath = `/admin/requests/${id}/note`;
const feedbackPath = "/admin/llm/feedback";
const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function advance(ms = 25) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}

async function setup() {
  const client = createAppQueryClient();
  clients.push(client);
  const failures = new Map<string, number>();
  const calls: { path: string; method: string; body: unknown }[] = [];
  const writes: ((status: number) => void)[] = [];
  const held = new Map<string, { promise: Promise<Response>; release: (status: number) => void }>();
  const body = (path: string): unknown => {
    if (path === "/admin/llm/timeseries") return { points: [] };
    if (path === "/admin/llm/evaluations")
      return { evaluations: [{ id: "public-eval", request_id: id, name: "quality" }] };
    if (path === feedbackPath) return { feedback: [] };
    if (path === "/admin/llm/prompts") return { prompts: [] };
    if (path === "/admin/llm/insights") return { insights: [] };
    if (path === "/admin/llm/patterns") return { patterns: [] };
    if (path === detailPath)
      return { request: { id, trace_id: "public-current-trace", prompt_name: "PUBLIC-CURRENT" } };
    if (path.endsWith("/explain")) return { request_id: id, routing: { detail: "PUBLIC-EXPLAIN" } };
    if (path.endsWith("/trace")) return { request_id: id, spans: [] };
    if (path.endsWith("/links")) return { request_id: id, counts: {}, governance: { blocked: false } };
    if (path === notePath)
      return {
        request_id: id,
        note: "PUBLIC-BASELINE",
        tags: [],
        exists: true,
        redacted_fields: [],
        created_by: "public-operator",
        updated_at: "2026-10-08T08:59:30Z",
      };
    throw new Error(`Unexpected synthetic path ${path}`);
  };
  const transport = new ApiClient({
    fetch: vi.fn(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (path === feedbackPath && method === "POST")
        return new Promise<Response>((resolve) => {
          writes.push((status) =>
            resolve(
              status === 201
                ? json({ feedback: { id: "public-feedback", request_id: id, rating: 1 } }, status)
                : json({ error: { message: "Synthetic failure" } }, status),
            ),
          );
        });
      const gate = held.get(path);
      if (gate) {
        held.delete(path);
        return gate.promise;
      }
      const status = failures.get(path);
      return status ? json({ error: { message: "Synthetic read failure" } }, status) : json(body(path));
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const success = vi.spyOn(toast, "success");
  const failure = vi.spyOn(toast, "error");
  const view = (readOnly = false) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/observability/llm?tab=evaluations"]}>
        <main id="main-content" tabIndex={-1}>
          <FeatureAccessHarness featureId="observability.llm" readOnly={readOnly}>
            <LLMPage />
          </FeatureAccessHarness>
        </main>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(view());
  await advance();
  const refresh = async (key: readonly unknown[]) => {
    act(() => {
      void client.invalidateQueries({ queryKey: key });
    });
    await advance();
  };
  return {
    client,
    calls,
    failures,
    success,
    failure,
    setReadOnly: async (value: boolean) => {
      rendered.rerender(view(value));
      await advance();
    },
    cache: () =>
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    refresh,
    deny: async (kind: "llm" | "note" | "explain" | "trace" | "links") => {
      failures.set(kind === "llm" ? detailPath : `/admin/requests/${id}/${kind}`, 403);
      await refresh(
        kind === "llm" ? ["observability", "llm", "trace", id] : ["observability", "requests", id, kind],
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("조회 권한을 다시 확인하세요.")).toBeVisible();
    },
    recover: async () => {
      failures.clear();
      await click(screen.getByRole("button", { name: "새로고침" }));
    },
    releaseWrite: async (index: number, status: number) => {
      const release = writes[index];
      if (!release) throw new Error("Synthetic write not dispatched");
      await act(async () => release(status));
      await advance();
    },
    holdRead: (path: string) => {
      let release!: (status: number) => void;
      const promise = new Promise<Response>((resolve) => {
        release = (status) => resolve(json({ error: { message: "Synthetic late denial" } }, status));
      });
      held.set(path, { promise, release });
      return async (status: number) => {
        await act(async () => release(status));
        await advance();
      };
    },
  };
}
async function trace() {
  await click(screen.getByRole("button", { name: `${id} 호출 상세 열기` }));
}
async function insight() {
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  expect(screen.getByText("메모: PUBLIC-BASELINE")).toBeVisible();
}
async function feedback() {
  await trace();
  await click(screen.getByRole("button", { name: "피드백 남기기" }));
  fireEvent.change(screen.getByRole("textbox", { name: "의견" }), { target: { value: "PUBLIC-USER-INPUT" } });
  await advance();
}
beforeEach(() => {
  vi.useFakeTimers();
  tokenStore.clearAll();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  tokenStore.clearAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["note", "explain", "links"] as const)(
  "retires on %s-only403 and returns focus after portal cleanup",
  async (kind) => {
    const current = await setup();
    await trace();
    await insight();
    await current.deny(kind);
    await advance(30);
    expect(current.cache()).not.toContain("PUBLIC-BASELINE");
    expect(current.cache()).not.toContain("PUBLIC-EXPLAIN");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "새로고침" }));
    await current.recover();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

it("does not let a cancelled old nested403 retire a recovered read lease", async () => {
  const current = await setup();
  await trace();
  await insight();
  const release = current.holdRead(`/admin/requests/${id}/explain`);
  await current.refresh(["observability", "requests", id, "explain"]);
  await current.deny("links");
  await current.recover();
  await trace();
  await insight();
  await release(403);
  expect(screen.getByRole("dialog", { name: "LLM 호출 상세" })).toBeVisible();
  expect(screen.queryByText("조회 권한을 다시 확인하세요.")).not.toBeInTheDocument();
  expect(current.cache()).toContain("PUBLIC-CURRENT");
});

it("restores only an explicitly selected unsent feedback draft and keeps its dirty close guard", async () => {
  const current = await setup();
  await feedback();
  await current.deny("llm");
  await current.recover();
  expect(screen.queryByRole("textbox", { name: "의견" })).not.toBeInTheDocument();
  expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  await trace();
  await click(screen.getByRole("button", { name: "피드백 초안 다시 열기" }));
  expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-USER-INPUT");
  expect(screen.getByRole("button", { name: "등록" })).toBeEnabled();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "피드백 남기기" }), { key: "Escape" });
  await advance();
  expect(screen.getByRole("alertdialog")).toBeVisible();
  await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "계속 편집" }));
  expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-USER-INPUT");
});

it("does not reopen private state after a failed recovery503 or a later successful refresh", async () => {
  const current = await setup();
  await feedback();
  await current.deny("llm");
  current.failures.delete(detailPath);
  current.failures.set("/admin/llm/evaluations", 503);
  await click(screen.getByRole("button", { name: "새로고침" }));
  await advance(2200);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "의견" })).not.toBeInTheDocument();
  current.failures.clear();
  await click(screen.getByRole("button", { name: "새로고침" }));
  expect(screen.getByRole("button", { name: `${id} 호출 상세 열기` })).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

it.each([201, 503])(
  "keeps a new feedback transmission locked when a discarded old one returns %s",
  async (status) => {
    const current = await setup();
    await feedback();
    await click(screen.getByRole("button", { name: "등록" }));
    await current.deny("llm");
    await current.recover();
    await trace();
    await click(screen.getByRole("button", { name: "피드백 초안 다시 열기" }));
    expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
    const oldForm = screen.getByRole("dialog", { name: "피드백 남기기" }).querySelector("form");
    if (!oldForm) throw new Error("Expected recovery form");
    fireEvent.submit(oldForm);
    await advance();
    expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "피드백 남기기" }), { key: "Escape" });
    await advance();
    const confirmation = screen.getByRole("alertdialog");
    await click(within(confirmation).getByRole("button", { name: /버리/ }));
    await click(screen.getByRole("button", { name: "피드백 남기기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "의견" }), {
      target: { value: "PUBLIC-NEW-INPUT" },
    });
    await click(screen.getByRole("button", { name: "등록" }));
    expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    await current.releaseWrite(0, status);
    expect(current.success).not.toHaveBeenCalled();
    expect(current.failure).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-NEW-INPUT");
    await current.releaseWrite(1, 201);
    expect(current.success).toHaveBeenCalledOnce();
  },
);

it("preserves a dirty note on ordinary trace503", async () => {
  const current = await setup();
  await trace();
  await insight();
  await click(screen.getByRole("button", { name: "메모·태그 수정" }));
  fireEvent.change(screen.getByRole("combobox", { name: "메모 변경 방법" }), {
    target: { value: "replace" },
  });
  await advance();
  fireEvent.change(screen.getByRole("textbox", { name: "새 메모" }), {
    target: { value: "PUBLIC-NOTE-INPUT" },
  });
  await advance();
  current.failures.set(detailPath, 503);
  await current.refresh(["observability", "llm", "trace", id]);
  await advance(2200);
  expect(screen.getByRole("textbox", { name: "새 메모" })).toHaveValue("PUBLIC-NOTE-INPUT");
  expect(screen.queryByText("조회 권한을 다시 확인하세요.")).not.toBeInTheDocument();
});

it.each([500, 503])(
  "allows only an explicit current-lease feedback retry after ordinary%s and write-only recovery",
  async (status) => {
    const current = await setup();
    await feedback();
    const dialog = screen.getByRole("dialog", { name: "피드백 남기기" });
    const form = dialog.querySelector("form");
    if (!form) throw new Error("Expected feedback form");
    await click(screen.getByRole("button", { name: "등록" }));
    await current.releaseWrite(0, status);
    expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-USER-INPUT");
    await current.setReadOnly(true);
    expect(screen.getByRole("dialog", { name: "피드백 남기기" })).toBe(dialog);
    expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
    fireEvent.submit(form);
    await advance();
    expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await current.setReadOnly(false);
    expect(screen.getByRole("button", { name: "등록" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-USER-INPUT");
    expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await click(screen.getByRole("button", { name: "등록" }));
    expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    await current.releaseWrite(1, 201);
    expect(screen.queryByRole("dialog", { name: "피드백 남기기" })).not.toBeInTheDocument();
    expect(current.success).toHaveBeenCalledOnce();
  },
);

it("keeps a completed ordinary feedback failure locked after later read denial and new-lease recovery", async () => {
  const current = await setup();
  await feedback();
  await click(screen.getByRole("button", { name: "등록" }));
  await current.releaseWrite(0, 500);
  await current.deny("llm");
  await current.recover();
  await trace();
  await click(screen.getByRole("button", { name: "피드백 초안 다시 열기" }));
  expect(screen.getByRole("textbox", { name: "의견" })).toHaveValue("PUBLIC-USER-INPUT");
  expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
  const form = screen.getByRole("dialog", { name: "피드백 남기기" }).querySelector("form");
  if (!form) throw new Error("Expected recovered feedback form");
  fireEvent.submit(form);
  await advance();
  expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(current.success).not.toHaveBeenCalled();
});
