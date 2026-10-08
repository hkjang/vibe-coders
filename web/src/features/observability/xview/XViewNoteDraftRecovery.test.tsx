import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XViewPage } from "./XViewPage";
import { requestNoteKey } from "@/features/observability/request-insight/request-note-state";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";

const identity = vi.hoisted(() => ({ principal: "public-a", team: "public-team-a", raw: true }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: ["admin:read", "admin:write"],
        rawPromptView: identity.raw,
        user: { id: identity.principal, team_id: identity.team },
      }),
  };
});

const requestId = "public-draft-request";
const userDraft = "PUBLIC-USER-REPLACEMENT-DRAFT";
const oldBaseline = "PUBLIC-OLD-SERVER-BASELINE";
const freshBaseline = "PUBLIC-FRESH-SERVER-BASELINE";
const cursor = { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: requestId };
function note(value: string, id = requestId) {
  return {
    request_id: id,
    note: value,
    tags: [],
    created_by: "public-operator",
    updated_at: "2026-10-08T08:00:00Z",
    exists: true,
    redacted_fields: identity.raw ? [] : ["note"],
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function advance(milliseconds = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}
function editor() {
  return screen.getByRole("dialog", { name: "요청 메모·태그 수정" });
}
function storageValues(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return key === null ? "" : (storage.getItem(key) ?? "");
  }).join("\n");
}
function expectDraftHidden() {
  expect(screen.queryByRole("dialog", { name: "요청 메모·태그 수정" })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(userDraft)).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(oldBaseline);
  expect(storageValues(window.localStorage)).not.toContain(userDraft);
  expect(storageValues(window.sessionStorage)).not.toContain(userDraft);
}

async function setup() {
  const state = {
    deltaStatus: 200,
    pointIds: [requestId],
    noteValue: oldBaseline,
    noteRead: undefined as (() => Response | Promise<Response>) | undefined,
    write: (): Response | Promise<Response> => json(note(userDraft)),
  };
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const rowId = decodeURIComponent(path.split("/")[3] ?? requestId);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "PATCH" && path.endsWith("/note")) return state.write();
      if (method !== "GET") throw new Error(`Unexpected synthetic write: ${method} ${path}`);
      if (path === "/admin/scatter")
        return json({
          points: state.pointIds.map((id) => ({
            request_id: id,
            created_at: "2026-10-08T08:59:30Z",
            latency_ms: 10,
            status_code: 200,
          })),
          cursor,
          server_time: "2026-10-08T09:00:00Z",
        });
      if (path === "/admin/xview/delta")
        return state.deltaStatus === 200
          ? json({ points: [], cursor, has_more: false, server_time: "2026-10-08T09:00:01Z" })
          : json(
              { error: { message: "Synthetic read denial", type: "permission_error" } },
              state.deltaStatus,
            );
      if (path === "/admin/saved-filters") return json({ filters: [] });
      if (path.endsWith("/note"))
        return state.noteRead ? state.noteRead() : json(note(state.noteValue, rowId));
      if (path.endsWith("/explain")) return json({ request_id: rowId });
      if (path.endsWith("/trace")) return json({ request_id: rowId, spans: [] });
      if (path.endsWith("/links"))
        return json({ request_id: rowId, counts: {}, governance: { blocked: false } });
      throw new Error(`Unexpected synthetic path: ${path}`);
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: vi.fn(),
    clearTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/observability/xview?window=5m"]}>
        <FeatureAccessHarness featureId="observability.xview">
          <XViewPage />
        </FeatureAccessHarness>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  await advance();
  const selectAndOpen = async () => {
    await click(screen.getByRole("button", { name: "최근 25건 선택" }));
    await click(screen.getByRole("button", { name: `${requestId} 원인 설명 열기` }));
  };
  await selectAndOpen();
  await click(screen.getByRole("button", { name: "메모·태그 수정" }));
  fireEvent.change(within(editor()).getByLabelText("메모 변경 방법"), { target: { value: "replace" } });
  await advance();
  fireEvent.change(within(editor()).getByLabelText("새 메모"), { target: { value: userDraft } });
  await advance();
  expect(within(editor()).getByLabelText("새 메모")).toHaveValue(userDraft);
  const deny = async () => {
    state.deltaStatus = 403;
    await advance(1_600);
    expectDraftHidden();
  };
  const freshSnapshot = async () => {
    state.deltaStatus = 200;
    await click(screen.getByRole("button", { name: "지금 새로고침" }));
    expectDraftHidden();
  };
  return {
    state,
    calls,
    client,
    selectAndOpen,
    deny,
    freshSnapshot,
    writes: () => calls.filter((call) => call.method !== "GET"),
    rerender: () => view.rerender(tree()),
  };
}

describe("independent XView opt-in note draft recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    identity.principal = "public-a";
    identity.team = "public-team-a";
    identity.raw = true;
    tokenStore.clearAll();
    toasts.success.mockClear();
    toasts.error.mockClear();
  });
  afterEach(() => {
    cleanup();
    tokenStore.clearAll();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("restores actual user values and dirty state only on explicit same-owner reopening with a fresh note receipt", async () => {
    const current = await setup();
    await current.deny();
    await current.freshSnapshot();
    const held = deferred();
    current.state.noteRead = () => held.promise;
    // A stale cache success must not stand in for a new note GET after denial.
    act(() =>
      current.client.setQueryData(requestNoteKey(requestId, tokenStore.getSessionEpoch()), note(oldBaseline)),
    );
    await current.selectAndOpen();
    const confirmation = screen.getByRole("alertdialog");
    expect(document.body).not.toHaveTextContent(oldBaseline);
    await click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    expect(within(editor()).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(oldBaseline);
    await act(async () => held.resolve(json(note(freshBaseline))));
    await advance();
    expect(within(editor()).getByLabelText("메모 변경 방법")).toHaveValue("replace");
    expect(within(editor()).getByLabelText("새 메모")).toHaveValue(userDraft);
    expect(document.body).not.toHaveTextContent(oldBaseline);
    expect(within(editor()).getByRole("button", { name: "메모·태그 저장" })).toBeEnabled();
    expect(current.writes()).toEqual([]);
    expect(storageValues(window.localStorage)).not.toContain(userDraft);
    expect(storageValues(window.sessionStorage)).not.toContain(userDraft);
    await click(within(editor()).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await click(screen.getByRole("button", { name: "계속 편집" }));
    expect(within(editor()).getByLabelText("새 메모")).toHaveValue(userDraft);
  });

  it("does not insert a cached pre-denial baseline into the DOM even transiently while the recovery GET is pending", async () => {
    const current = await setup();
    await current.deny();
    await current.freshSnapshot();
    const held = deferred();
    current.state.noteRead = () => held.promise;
    act(() =>
      current.client.setQueryData(requestNoteKey(requestId, tokenStore.getSessionEpoch()), note(oldBaseline)),
    );
    const inserted: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) inserted.push(node.textContent ?? "");
        if (record.type === "characterData") inserted.push(record.target.textContent ?? "");
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      await current.selectAndOpen();
      await click(screen.getByRole("button", { name: "계속 편집" }));
      expect(within(editor()).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
      expect(inserted.join("\n")).not.toContain(oldBaseline);
      expect(document.body).not.toHaveTextContent(oldBaseline);
    } finally {
      observer.disconnect();
      await act(async () => held.resolve(json(note(freshBaseline))));
      await advance();
    }
  });

  it.each(["principal", "team", "session", "raw capability", "principal ABA"] as const)(
    "never revives a suspended draft after changing the %s authority",
    async (boundary) => {
      const current = await setup();
      await current.deny();
      current.state.deltaStatus = 200;
      current.state.noteValue = freshBaseline;
      if (boundary === "principal" || boundary === "principal ABA") identity.principal = "public-b";
      if (boundary === "team") identity.team = "public-team-b";
      if (boundary === "raw capability") identity.raw = false;
      if (boundary === "session") act(() => tokenStore.clearAll());
      else current.rerender();
      await advance();
      if (boundary === "principal ABA") {
        identity.principal = "public-a";
        current.rerender();
        await advance();
      }
      expectDraftHidden();
      await current.selectAndOpen();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "요청 메모·태그 수정" })).not.toBeInTheDocument();
      await click(screen.getByRole("button", { name: "메모·태그 수정" }));
      expect(within(editor()).getByLabelText("메모 변경 방법")).toHaveValue("preserve");
      expect(screen.queryByDisplayValue(userDraft)).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(oldBaseline);
      expect(current.writes()).toEqual([]);
    },
  );

  it("does not attach the suspended request's draft to a different currently selected request", async () => {
    const current = await setup();
    await current.deny();
    current.state.pointIds = [requestId, "public-other-request"];
    current.state.noteValue = freshBaseline;
    await current.freshSnapshot();
    await click(screen.getByRole("button", { name: "최근 25건 선택" }));
    await click(screen.getByRole("button", { name: "public-other-request 원인 설명 열기" }));
    const confirmation = screen.queryByRole("alertdialog");
    if (confirmation) await click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    expect(screen.queryByDisplayValue(userDraft)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(oldBaseline);
    expect(current.writes()).toEqual([]);
  });

  it.each([200, 503])(
    "does not replay a detached POST after a late %i outcome; a new instance requires explicit discard",
    async (status) => {
      const current = await setup();
      const pending = deferred();
      current.state.write = () => pending.promise;
      await click(within(editor()).getByRole("button", { name: "메모·태그 저장" }));
      expect(current.writes()).toHaveLength(1);
      await current.deny();
      const invalidations = vi.spyOn(current.client, "invalidateQueries");
      const beforeAck = current.calls.length;
      await act(async () =>
        pending.resolve(
          status === 200
            ? json(note(userDraft))
            : json(
                { error: { message: "Synthetic write outcome unavailable", type: "server_error" } },
                status,
              ),
        ),
      );
      await advance();
      expect(current.calls).toHaveLength(beforeAck);
      expect(current.writes()).toHaveLength(1);
      expect(invalidations).not.toHaveBeenCalled();
      expect(toasts.success).not.toHaveBeenCalled();
      expect(toasts.error).not.toHaveBeenCalled();
      expectDraftHidden();
      current.state.noteValue = status === 200 ? userDraft : freshBaseline;
      await current.freshSnapshot();
      await current.selectAndOpen();
      await click(screen.getByRole("button", { name: "계속 편집" }));
      const resumed = editor();
      expect(within(resumed).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
      const form = resumed.querySelector("form");
      expect(form).not.toBeNull();
      if (form) fireEvent.submit(form);
      await advance();
      expect(current.writes()).toHaveLength(1);
      await click(within(resumed).getByRole("button", { name: "취소" }));
      await click(screen.getByRole("button", { name: "변경 버리기" }));
      await click(screen.getByRole("button", { name: "메모·태그 수정" }));
      const replacement = editor();
      expect(within(replacement).getByRole("button", { name: "메모·태그 저장" })).toBeEnabled();
      fireEvent.change(within(replacement).getByLabelText("메모 변경 방법"), {
        target: { value: "replace" },
      });
      await advance();
      fireEvent.change(within(replacement).getByLabelText("새 메모"), {
        target: { value: "PUBLIC-NEW-INSTANCE-EDIT" },
      });
      await advance();
      current.state.write = () => json(note("PUBLIC-NEW-INSTANCE-EDIT"));
      await click(within(replacement).getByRole("button", { name: "메모·태그 저장" }));
      expect(current.writes()).toHaveLength(2);
      expect(JSON.parse(current.writes()[1]?.body ?? "{}")).toMatchObject({
        note: "PUBLIC-NEW-INSTANCE-EDIT",
      });
    },
  );
});
