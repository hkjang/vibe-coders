import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { contextMetadataPageSchema } from "@/shared/api/domains/context-registry";
import { PromptLibraryPage } from "./PromptLibraryPage";

const runtime = vi.hoisted(() => ({ version: "v0.86.130", id: "public-reader", scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ backendVersion: runtime.version, user: { id: runtime.id }, scopes: runtime.scopes }),
  };
});
const row = {
  key: "public-reference",
  name: "공개 참고자료",
  enabled: true,
  token_estimate: 128,
  use_count: 9,
  last_used_at: null,
  updated_at: "2026-11-17T03:00:00Z",
};
function response(offset = 0, state = "all", limit = 25) {
  return {
    items: [{ ...row, enabled: state !== "disabled" }],
    total: 30,
    offset,
    limit,
    state,
    generated_at: "2026-11-17T04:00:00Z",
  };
}
function setup(handler: ApiHandler, route = "/prompts/library?tab=contexts") {
  const api = mockApi({ "GET /admin/contexts": handler });
  const tree = () => (
    <FeatureAccessContext.Provider
      value={{ featureId: "prompts.library", permitted: true, readOnly: true, status: "preview" }}
    >
      <PromptLibraryPage />
    </FeatureAccessContext.Provider>
  );
  const view = renderScreen(tree(), { route });
  return { ...view, api, user: userEvent.setup(), update: () => view.rerender(tree()) };
}
beforeEach(() => {
  vi.restoreAllMocks();
  runtime.version = "v0.86.130";
  runtime.id = "public-reader";
  runtime.scopes = ["admin:read"];
});

describe("공용 참고자료 조회", () => {
  it("uses bounded metadata and preserves server state and page inputs", async () => {
    const view = setup(({ query }) =>
      response(Number((query as { offset: number }).offset), String((query as { state: string }).state)),
    );
    await screen.findByText(row.name);
    expect(view.api.calls[0]?.options.query).toEqual({
      view: "metadata",
      limit: 25,
      offset: 0,
      state: "all",
    });
    const table = within(screen.getByRole("table", { name: "공용 참고자료 목록" }));
    expect(table.getByText("기록 없음")).toBeVisible();
    await view.user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 25 }));
    await view.user.selectOptions(screen.getByRole("combobox", { name: "참고자료 사용 상태" }), "disabled");
    await waitFor(() =>
      expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 0, state: "disabled" }),
    );
    expect(view.api.calls.every(({ key }) => key === "GET /admin/contexts")).toBe(true);
  });
  it("does not fetch content from older backends", async () => {
    runtime.version = "v0.86.129";
    const view = setup(() => response());
    expect(await screen.findByText(/백엔드 v0.86.130 이상/)).toBeVisible();
    expect(view.api.calls).toEqual([]);
  });
  it("retires previous data on denial and requires explicit new read", async () => {
    let denied = false;
    const view = setup(() => {
      if (denied) throw apiFailure("private-error", 403);
      return response();
    });
    await screen.findByText(row.name);
    denied = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" });
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(row.name);
    denied = false;
    await view.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await screen.findByText(row.name);
  });
  it("keeps last successful page on a transient refresh failure", async () => {
    let failed = false;
    const view = setup(() => {
      if (failed) throw apiFailure("private-error", 503);
      return response();
    });
    await screen.findByText(row.name);
    failed = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByText(/마지막으로 확인된 내용/);
    expect(screen.getByText(row.name)).toBeVisible();
    expect(screen.queryByText("private-error")).not.toBeInTheDocument();
  });
  it("rejects a page receipt for another request", async () => {
    setup(() => response(25));
    await screen.findAllByText(/불러오지 못했습니다/);
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  });
  it("keeps body fields out of the response contract", () => {
    expect(
      contextMetadataPageSchema.safeParse({ ...response(), items: [{ ...row, content: "private-content" }] })
        .success,
    ).toBe(false);
    expect(
      contextMetadataPageSchema.safeParse({ ...response(), items: [{ ...row, use_count: -1 }] }).success,
    ).toBe(false);
  });
  it("shows empty pages with an explicit route to the first page", async () => {
    const view = setup(
      ({ query }) => ({ ...response((query as { offset: number }).offset), items: [] }),
      "/prompts/library?tab=contexts&contexts_page=3",
    );
    await screen.findByText(/이 페이지에 참고자료가 없습니다/);
    expect(screen.queryByRole("button", { name: "이전" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다음" })).not.toBeInTheDocument();
    await view.user.click(screen.getByRole("button", { name: "첫 페이지 보기" }));
    await waitFor(() => expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 0 }));
  });
});
