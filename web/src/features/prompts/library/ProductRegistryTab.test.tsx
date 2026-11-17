import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { productMetadataPageSchema } from "@/shared/api/domains/prompt-products";
import { PromptLibraryPage } from "./PromptLibraryPage";

const runtime = vi.hoisted(() => ({ version: "v0.86.131", id: "public-reader", scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ backendVersion: runtime.version, user: { id: runtime.id }, scopes: runtime.scopes }),
  };
});
const row = {
  name: "공개 제품",
  category: "product",
  template_state: "enabled",
  source_requests: 12,
  source_distinct_keys: 3,
  use_count: 9,
  last_used_at: null,
  created_at: "2026-11-17T03:00:00Z",
};
function response(offset = 0, state = "all", limit = 25) {
  return {
    items: [{ ...row, template_state: state === "all" ? "enabled" : state }],
    total: 30,
    offset,
    limit,
    state,
    generated_at: "2026-11-17T04:00:00Z",
  };
}
function setup(handler: ApiHandler, route = "/prompts/library?tab=products") {
  const api = mockApi({ "GET /admin/prompt-products": handler });
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
  runtime.version = "v0.86.131";
  runtime.id = "public-reader";
  runtime.scopes = ["admin:read"];
});

describe("프롬프트 제품 조회", () => {
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
    const table = within(screen.getByRole("table", { name: "프롬프트 제품 목록" }));
    expect(table.getByText("기록 없음")).toBeVisible();
    await view.user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 25 }));
    await view.user.selectOptions(screen.getByRole("combobox", { name: "원본 템플릿 상태" }), "disabled");
    await waitFor(() =>
      expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 0, state: "disabled" }),
    );
    expect(view.api.calls.every(({ key }) => key === "GET /admin/prompt-products")).toBe(true);
  });
  it("does not fetch content from older backends", async () => {
    runtime.version = "v0.86.130";
    const view = setup(() => response());
    expect(await screen.findByText(/백엔드 v0.86.131 이상/)).toBeVisible();
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
    await screen.findAllByText("프롬프트 제품을 조회하지 못했습니다.");
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  });
  it("keeps body fields out of the response contract", () => {
    expect(
      productMetadataPageSchema.safeParse({ ...response(), items: [{ ...row, content: "private-content" }] })
        .success,
    ).toBe(false);
    expect(
      productMetadataPageSchema.safeParse({ ...response(), items: [{ ...row, use_count: -1 }] }).success,
    ).toBe(false);
  });
  it("shows empty pages with an explicit route to the first page", async () => {
    const view = setup(
      ({ query }) => ({ ...response((query as { offset: number }).offset), items: [] }),
      "/prompts/library?tab=products&products_page=3",
    );
    await screen.findByText(/이 페이지에 표시할 제품이 없습니다/);
    expect(screen.queryByRole("button", { name: "이전" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다음" })).not.toBeInTheDocument();
    await view.user.click(screen.getByRole("button", { name: "첫 페이지로 이동" }));
    await waitFor(() => expect(view.api.calls.at(-1)?.options.query).toMatchObject({ offset: 0 }));
  });
  it("distinguishes a missing template from a zero-use template and API keys from people", async () => {
    setup(() => ({ ...response(), items: [{ ...row, template_state: "missing", use_count: null }] }));
    const table = within(await screen.findByRole("table", { name: "프롬프트 제품 목록" }));
    await screen.findByText(row.name);
    expect(table.getAllByText("원본 없음")).toHaveLength(3);
    expect(table.getByRole("columnheader", { name: /등록 시 키/ })).toBeVisible();
    expect(screen.getByText(/사람 수가 아닙니다/)).toBeVisible();
  });
  it("rejects fabricated zero usage for a missing template", async () => {
    setup(() => ({ ...response(), items: [{ ...row, template_state: "missing", use_count: 0 }] }));
    await screen.findAllByText("프롬프트 제품을 조회하지 못했습니다.");
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  });
  it("does not display absent registration usage as zero", async () => {
    setup(() => ({ ...response(), items: [{ ...row, source_requests: null, source_distinct_keys: null }] }));
    await screen.findByText(row.name);
    const table = within(screen.getByRole("table", { name: "프롬프트 제품 목록" }));
    expect(table.getAllByText("미확인")).toHaveLength(2);
    expect(screen.getByText(/원본 사용 기록을 연결하지 않은 제품은 미확인/)).toBeVisible();
  });
});
