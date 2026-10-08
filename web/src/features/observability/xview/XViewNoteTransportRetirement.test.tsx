import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { XViewPage } from "./XViewPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function advance(milliseconds = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}
afterEach(() => {
  cleanup();
  tokenStore.clearAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["refresh token", "changed access token"] as const)(
  "does not transport-replay a retired XView note PATCH after late401 with a %s",
  async (retryBranch) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    tokenStore.clearAll();
    const epoch = tokenStore.getSessionEpoch();
    let deltaStatus = 200;
    let accessToken = "public-synthetic-access-before";
    let settleWrite: ((response: Response) => void) | undefined;
    const pendingWrite = new Promise<Response>((resolve) => {
      settleWrite = resolve;
    });
    const calls: Array<{ path: string; method: string }> = [];
    const id = "public-note-transport-request";
    const cursor = { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: id };
    const note = {
      request_id: id,
      note: "PUBLIC-SERVER-NOTE",
      tags: [],
      created_by: "public-user",
      updated_at: "2026-10-08T08:00:00Z",
      exists: true,
      redacted_fields: [],
    };
    const writes = () => calls.filter((call) => call.method === "PATCH");
    const transport = new ApiClient({
      fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const path = new URL(String(input), "http://public-test.invalid").pathname;
        const method = init?.method ?? "GET";
        calls.push({ path, method });
        if (path === "/auth/refresh")
          return json({
            access_token: "public-synthetic-access-after",
            refresh_token: "public-synthetic-refresh-after",
            token_type: "Bearer",
            expires_in: 60,
            refresh_expires_in: 120,
          });
        if (method === "PATCH" && path.endsWith("/note"))
          return writes().length === 1 ? pendingWrite : json(note);
        if (method !== "GET") throw new Error("Unexpected synthetic write method");
        if (path === "/admin/scatter")
          return json({
            points: [
              { request_id: id, created_at: "2026-10-08T08:59:30Z", latency_ms: 10, status_code: 200 },
            ],
            cursor,
            server_time: "2026-10-08T09:00:00Z",
          });
        if (path === "/admin/xview/delta")
          return deltaStatus === 200
            ? json({ points: [], cursor, has_more: false, server_time: "2026-10-08T09:00:01Z" })
            : json({ error: { message: "Synthetic read denied", type: "permission_error" } }, 403);
        if (path === "/admin/saved-filters") return json({ filters: [] });
        if (path.endsWith("/note")) return json(note);
        if (path.endsWith("/explain")) return json({ request_id: id });
        if (path.endsWith("/trace")) return json({ request_id: id, spans: [] });
        if (path.endsWith("/links"))
          return json({ request_id: id, counts: {}, governance: { blocked: false } });
        throw new Error("Unexpected synthetic request path");
      }),
      getAccessToken: () => accessToken,
      getRefreshToken: () => (retryBranch === "refresh token" ? "public-synthetic-refresh-before" : ""),
      getLegacyToken: () => "",
      getSessionEpoch: tokenStore.getSessionEpoch,
      saveTokens: (tokens) => {
        accessToken = tokens.access_token;
      },
      clearTokens: vi.fn(),
      notifyLogout: vi.fn(),
    });
    vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
      transport.request(endpoint, ...args),
    );
    renderScreen(
      <FeatureAccessHarness featureId="observability.xview">
        <XViewPage />
      </FeatureAccessHarness>,
      { path: "/observability/xview", route: "/observability/xview?window=5m" },
    );
    await advance();
    await click(screen.getByRole("button", { name: "최근 25건 선택" }));
    await click(screen.getByRole("button", { name: `${id} 원인 설명 열기` }));
    await click(screen.getByRole("button", { name: "메모·태그 수정" }));
    const editor = screen.getByRole("dialog", { name: "요청 메모·태그 수정" });
    fireEvent.change(within(editor).getByLabelText("메모 변경 방법"), { target: { value: "replace" } });
    await advance();
    fireEvent.change(within(editor).getByLabelText("새 메모"), { target: { value: "PUBLIC-USER-DRAFT" } });
    await advance();
    await click(within(editor).getByRole("button", { name: "메모·태그 저장" }));
    expect(writes()).toHaveLength(1);
    deltaStatus = 403;
    await advance(1_600);
    expect(screen.queryByRole("dialog", { name: "요청 메모·태그 수정" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("PUBLIC-SERVER-NOTE");
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    if (retryBranch === "changed access token") accessToken = "public-synthetic-access-after";
    expect(settleWrite).toBeTypeOf("function");
    await act(async () =>
      settleWrite?.(
        json(
          { error: { message: "Synthetic write authentication expired", type: "authentication_error" } },
          401,
        ),
      ),
    );
    await advance();
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    // A transport-level retry is still a second side-effecting request, even
    // when the retired editor correctly suppresses its eventual toast.
    expect(writes()).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/auth/refresh")).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "요청 메모·태그 수정" })).not.toBeInTheDocument();
  },
);
