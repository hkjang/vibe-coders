import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { XViewPage } from "./XViewPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("can actually continue a user-authored note after denial retirement and an explicit successful read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let deltaStatus = 200;
  const writes: string[] = [];
  const cursor = { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: "public-note-request" };
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      if (init?.method !== "GET") writes.push(path);
      let body: unknown;
      let status = 200;
      if (path === "/admin/scatter")
        body = {
          points: [
            {
              request_id: "public-note-request",
              created_at: "2026-10-08T08:59:30Z",
              latency_ms: 10,
              status_code: 200,
            },
          ],
          cursor,
          server_time: "2026-10-08T09:00:00Z",
        };
      else if (path === "/admin/xview/delta") {
        status = deltaStatus;
        body =
          status === 200
            ? { points: [], cursor, has_more: false, server_time: "2026-10-08T09:00:01Z" }
            : { error: { message: "Synthetic read denied", type: "permission_error" } };
      } else if (path === "/admin/saved-filters") body = { filters: [] };
      else if (path.endsWith("/note"))
        body = {
          request_id: "public-note-request",
          tags: [],
          note: "PUBLIC-STORED-NOTE",
          created_by: "public-user",
          updated_at: "2026-10-08T08:00:00Z",
          exists: true,
          redacted_fields: [],
        };
      else if (path.endsWith("/explain")) body = { request_id: "public-note-request" };
      else if (path.endsWith("/trace")) body = { request_id: "public-note-request", spans: [] };
      else if (path.endsWith("/links"))
        body = { request_id: "public-note-request", counts: {}, governance: { blocked: false } };
      else throw new Error(`Unexpected synthetic transport path: ${path}`);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
    clearTokens: vi.fn(),
    saveTokens: vi.fn(),
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
  await advance(20);
  fireEvent.click(screen.getByRole("button", { name: "최근 25건 선택" }));
  await advance(20);
  fireEvent.click(screen.getByRole("button", { name: "public-note-request 원인 설명 열기" }));
  await advance(20);
  fireEvent.click(screen.getByRole("button", { name: "메모·태그 수정" }));
  await advance(20);
  const editor = screen.getByRole("dialog", { name: "요청 메모·태그 수정" });
  fireEvent.change(within(editor).getByLabelText("메모 변경 방법"), { target: { value: "replace" } });
  await advance(20);
  fireEvent.change(within(editor).getByLabelText("새 메모"), {
    target: { value: "PUBLIC-USER-AUTHORED-DRAFT" },
  });
  await advance(20);
  expect(within(editor).getByLabelText("새 메모")).toHaveValue("PUBLIC-USER-AUTHORED-DRAFT");
  deltaStatus = 403;
  await advance(1_600);
  expect(screen.queryByRole("dialog", { name: "요청 메모·태그 수정" })).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("PUBLIC-STORED-NOTE");
  expect(screen.queryByDisplayValue("PUBLIC-USER-AUTHORED-DRAFT")).not.toBeInTheDocument();
  expect(writes).toEqual([]);

  // Fresh 200 explicitly reconfirms the same request. A normal confirmation is
  // not itself a failure; choosing Continue Editing must lead to a usable draft.
  deltaStatus = 200;
  fireEvent.click(screen.getByRole("button", { name: "지금 새로고침" }));
  await advance(20);
  fireEvent.click(screen.getByRole("button", { name: "최근 25건 선택" }));
  await advance(20);
  fireEvent.click(screen.getByRole("button", { name: "public-note-request 원인 설명 열기" }));
  await advance(20);
  const confirmation = screen.getByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "계속 편집" }));
  await advance(20);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(writes).toEqual([]);
  const resumed = screen.queryByRole("dialog", { name: "요청 메모·태그 수정" });
  expect(resumed).not.toBeNull();
  if (resumed) expect(within(resumed).getByLabelText("새 메모")).toHaveValue("PUBLIC-USER-AUTHORED-DRAFT");
});
