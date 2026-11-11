import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { PromptLibraryPage } from "./PromptLibraryPage";
import { libraryCsvHeaders } from "./library-csv";
import { hiddenLibraryText } from "./library-model";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  readOnly: false,
  scopes: ["admin:read", "admin:write"],
}));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const download = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/shared/utils/csv", async (original) => ({ ...(await original<object>()), downloadCsv: download }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: ["public_credential_"],
    }),
  };
});
const asset = {
  id: "public-asset",
  name: "공개 자산",
  category: "custom",
  description: "공개 설명",
  body: "공개 본문",
  tags: ["공개"],
  status: "draft",
  enabled: true,
  note: "",
  updated_at: "2030-01-01T00:00:00Z",
};
function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/prompts/library?tab=search")}>검색 화면으로</button>
      <button onClick={() => navigate("/prompts/library?tab=assets")}>자산 목록으로</button>
    </>
  );
}
function setup(extra: Record<string, ApiHandler> = {}, route = "/prompts/library?tab=assets") {
  const api = mockApi({
    "GET /admin/prompt-assets": () => ({
      assets: [asset],
      categories: [],
      known_tags: [],
      stats: { draft: 1 },
    }),
    "GET /admin/templates/public-asset/history": () => ({ history: [] }),
    "GET /admin/templates/public-asset/usage": () => ({ usage: [] }),
    "GET /admin/prompts": () => ({ requests: [] }),
    "GET /admin/prompts/fingerprints": () => ({ fingerprints: [] }),
    "GET /admin/saved-filters": () => ({ filters: [] }),
    "PATCH /admin/templates/public-asset": ({ body }) => ({ template: { ...asset, ...(body as object) } }),
    ...extra,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <FeatureAccessContext.Provider
          value={{
            featureId: "prompts.library",
            permitted: true,
            readOnly: runtime.readOnly,
            status: "preview",
          }}
        >
          <PromptLibraryPage />
          <Navigation />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, client, user: userEvent.setup(), update: () => view.rerender(tree()) };
}
async function edit(view: ReturnType<typeof setup>, name = "변경 이름") {
  await view.user.click(await screen.findByRole("button", { name: "공개 자산 편집" }));
  const dialog = within(screen.getByRole("dialog", { name: "프롬프트 자산 편집" }));
  await view.user.clear(dialog.getByRole("textbox", { name: /^이름/ }));
  await view.user.type(dialog.getByRole("textbox", { name: /^이름/ }), name);
  return dialog;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    readOnly: false,
    scopes: ["admin:read", "admin:write"],
  });
  tokenStore.clearAll();
  vi.clearAllMocks();
});
describe("프롬프트 보관함 권한과 변경 검증", () => {
  it("preserves the detail trigger element and restores focus after closing", async () => {
    const view = setup();
    const trigger = await screen.findByRole("button", { name: "공개 자산" });
    await view.user.click(trigger);
    await screen.findByRole("dialog", { name: asset.name });
    expect(trigger.isConnected).toBe(true);
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("keeps the draft and blocks saving when the feature becomes readonly", async () => {
    const view = setup(),
      dialog = await edit(view);
    runtime.readOnly = true;
    view.update();
    expect(dialog.getByRole("textbox", { name: /^이름/ })).toHaveValue("변경 이름");
    expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    runtime.readOnly = false;
    view.update();
    expect(dialog.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(view.api.calls.every((call) => call.key.startsWith("GET"))).toBe(true);
  });
  it("discards previous principal drafts and owned queries on account change", async () => {
    const view = setup();
    await edit(view);
    const hashes = view.client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryHash);
    runtime.id = "public-b";
    view.update();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .every((query) => !hashes.includes(query.queryHash)),
    ).toBe(true);
    await view.user.click(await screen.findByRole("button", { name: "공개 자산 편집" }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox", { name: /^이름/ })).toHaveValue(
      asset.name,
    );
  });
  it("clears all owned content on read denial and allows an explicit retry", async () => {
    let denied = false;
    const view = setup({
      "GET /admin/prompt-assets": () => {
        if (denied) throw apiFailure("private response", 403);
        return { assets: [asset] };
      },
    });
    await screen.findByRole("button", { name: "공개 자산 편집" });
    denied = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" });
    expect(screen.queryByText(asset.name)).not.toBeInTheDocument();
    expect(view.client.getQueryCache().getAll()).toHaveLength(0);
    denied = false;
    await view.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await screen.findByRole("button", { name: "공개 자산 편집" });
  });
  it("fails closed when a preflight read loses permission, without sending the mutation", async () => {
    let denied = false;
    const view = setup({
      "GET /admin/prompt-assets": () => {
        if (denied) throw apiFailure("private response", 403);
        return { assets: [asset] };
      },
    });
    const dialog = await edit(view);
    denied = true;
    await view.user.click(dialog.getByRole("button", { name: "저장" }));
    await screen.findByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" });
    expect(view.api.bodies("PATCH /admin/templates/public-asset")).toHaveLength(0);
  });
  it("rejects a changed asset discovered immediately before saving", async () => {
    let current = { ...asset };
    const view = setup({ "GET /admin/prompt-assets": () => ({ assets: [current] }) });
    const dialog = await edit(view);
    current = { ...current, body: "다른 관리자가 수정한 본문" };
    await view.user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    expect(view.api.bodies("PATCH /admin/templates/public-asset")).toHaveLength(0);
    expect(dialog.getByRole("textbox", { name: /^이름/ })).toHaveValue("변경 이름");
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("does not overwrite a stored masked body when only the name changes", async () => {
    const secretAsset = {
      ...asset,
      body: "public_credential_example123456789012345678901234567890",
      undeclared: "private-extra",
    };
    const view = setup({
      "GET /admin/prompt-assets": () => ({ assets: [secretAsset] }),
      "PATCH /admin/templates/public-asset": ({ body }) => ({
        template: { ...secretAsset, ...(body as object) },
      }),
    });
    const dialog = await edit(view);
    expect(dialog.getByRole("textbox", { name: /^프롬프트 본문/ })).toHaveValue(hiddenLibraryText);
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toMatch(/public_credential_example123456789012345678901234567890|private-extra/);
    await view.user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(notifications.success).toHaveBeenCalledWith("프롬프트 자산을 수정했습니다."));
    expect(view.api.bodies("PATCH /admin/templates/public-asset")).toEqual([{ name: "변경 이름" }]);
    expect(
      view.client
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.data === undefined),
    ).toBe(true);
  });
  it("blocks repeat submission after a mismatched success receipt", async () => {
    const view = setup({
      "PATCH /admin/templates/public-asset": () => ({ template: { ...asset, id: "wrong-id" } }),
    });
    const dialog = await edit(view);
    await view.user.click(dialog.getByRole("button", { name: "저장" }));
    await screen.findByText("이전 작업 결과 확인 필요");
    expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(view.api.bodies("PATCH /admin/templates/public-asset")).toHaveLength(1);
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("checks a normalized ID collision without calling the upsert endpoint", async () => {
    const view = setup();
    await view.user.click(screen.getByRole("button", { name: "새 자산" }));
    const dialog = within(screen.getByRole("dialog"));
    await view.user.type(dialog.getByRole("textbox", { name: /^이름/ }), "새 이름");
    await view.user.type(dialog.getByLabelText("식별자 (ID)"), "PUBLIC ASSET");
    await view.user.type(dialog.getByRole("textbox", { name: /^프롬프트 본문/ }), "새 본문");
    await view.user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    expect(view.api.bodies("POST /admin/templates")).toHaveLength(0);
  });
  it("finds deep-linked details even when list filters hide the selected asset", async () => {
    setup(
      { "GET /admin/prompt-assets": ({ query }) => ({ assets: query && "q" in query ? [] : [asset] }) },
      "/prompts/library?tab=assets&asset_q=no-match&asset=public-asset",
    );
    const dialog = await screen.findByRole("dialog", { name: asset.name });
    expect(within(dialog).getByText(asset.body)).toBeInTheDocument();
  });
  it("permits direct copy but disables the usage write in readonly mode", async () => {
    runtime.readOnly = true;
    const view = setup({}, "/prompts/library?tab=assets&asset=public-asset");
    await screen.findByRole("dialog", { name: asset.name });
    expect(screen.getByRole("button", { name: "본문 복사" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "복사 및 사용 기록 요청" })).toBeDisabled();
    expect(view.api.calls.every((call) => call.key.startsWith("GET"))).toBe(true);
  });
  it("refreshes the current owner after a pending write survives tab remount without late feedback", async () => {
    const pending = deferred<unknown>();
    let current = { ...asset };
    const view = setup({
      "GET /admin/prompt-assets": () => ({ assets: [current] }),
      "PATCH /admin/templates/public-asset": () => pending.promise,
    });
    await view.user.click(await screen.findByRole("switch", { name: "공개 자산 사용" }));
    await waitFor(() => expect(view.api.bodies("PATCH /admin/templates/public-asset")).toHaveLength(1));
    await view.user.click(screen.getByRole("button", { name: "검색 화면으로" }));
    await view.user.click(screen.getByRole("button", { name: "자산 목록으로" }));
    expect(await screen.findByRole("switch", { name: "공개 자산 사용" })).toBeDisabled();
    current = { ...current, enabled: false };
    await act(async () => pending.resolve({ template: current }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "공개 자산 사용" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "공개 자산 사용" })).not.toBeChecked();
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("does not invalidate the next account after the previous account's write completes", async () => {
    const pending = deferred<unknown>();
    const view = setup({ "PATCH /admin/templates/public-asset": () => pending.promise });
    await view.user.click(await screen.findByRole("switch", { name: "공개 자산 사용" }));
    await waitFor(() => expect(view.api.bodies("PATCH /admin/templates/public-asset")).toHaveLength(1));
    runtime.id = "public-b";
    view.update();
    await screen.findByRole("switch", { name: "공개 자산 사용" });
    const reads = view.api.calls.filter((call) => call.key === "GET /admin/prompt-assets").length;
    await act(async () => pending.resolve({ template: { ...asset, enabled: false } }));
    expect(view.api.calls.filter((call) => call.key === "GET /admin/prompt-assets")).toHaveLength(reads);
    expect(screen.getByRole("switch", { name: "공개 자산 사용" })).toBeChecked();
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("does not replay a write after a 401 response", async () => {
    const view = setup({
      "PATCH /admin/templates/public-asset": () => {
        throw apiFailure("public unauthorized", 401);
      },
    });
    await view.user.click(await screen.findByRole("switch", { name: "공개 자산 사용" }));
    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    const writes = view.api.spy.mock.calls.filter(([endpoint]) => endpoint.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toMatchObject({ retryUnauthorized: false });
  });
  it("discards a CSV response when the authenticated principal changes", async () => {
    const pending = deferred<string>();
    const view = setup({ "GET /admin/export.csv": () => pending.promise }, "/prompts/library?tab=search");
    await view.user.click(screen.getByRole("button", { name: "CSV 다운로드" }));
    await waitFor(() =>
      expect(view.api.calls.some((call) => call.key === "GET /admin/export.csv")).toBe(true),
    );
    runtime.id = "public-b";
    view.update();
    await act(async () => pending.resolve(libraryCsvHeaders.join(",") + "\n"));
    expect(download).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
  });
  it("preserves focused row actions when an unchanged list refreshes", async () => {
    const view = setup();
    const button = await screen.findByRole("button", { name: "공개 자산 편집" });
    button.focus();
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["prompts", "assets"] });
    });
    expect(screen.getByRole("button", { name: "공개 자산 편집" })).toHaveFocus();
  });
});
