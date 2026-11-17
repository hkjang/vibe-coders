import { useReducer } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { contextMetadataQuerySchema } from "@/shared/api/domains/context-registry";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { PromptLibraryPage } from "./PromptLibraryPage";
import { readContextSearch, validContextSearch } from "./context-search";
const runtime = vi.hoisted(() => ({ version: "v0.86.134", id: "context-reader" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ backendVersion: runtime.version, user: { id: runtime.id }, scopes: ["admin:read"] }),
      credentialPrefixes: ["corp_"],
    }),
  };
});
beforeEach(() => {
  runtime.version = "v0.86.134";
  runtime.id = "context-reader";
});
function Location() {
  const l = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 조회 주소">{l.search}</output>
      <button onClick={() => void navigate(-1)}>이전 주소</button>
    </>
  );
}
function setup(route = "/prompts/library?tab=contexts") {
  const api = mockApi({
    "GET /admin/contexts": ({ query }) => {
      const q = contextMetadataQuerySchema.parse(query);
      return {
        items: [
          {
            key: "reference",
            name: "검색 결과 자료",
            enabled: q.state !== "disabled",
            token_estimate: 1,
            use_count: 2,
            last_used_at: null,
            updated_at: null,
          },
        ],
        total: 31,
        limit: q.limit,
        offset: q.offset,
        state: q.state,
        generated_at: "2026-11-17T03:00:00Z",
      };
    },
  });
  const tree = () => (
    <FeatureAccessContext.Provider
      value={{ featureId: "prompts.library", permitted: true, readOnly: true, status: "preview" }}
    >
      <PromptLibraryPage />
      <Location />
    </FeatureAccessContext.Provider>
  );
  function Harness() {
    const [, render] = useReducer((value: number) => value + 1, 0);
    return (
      <>
        {tree()}
        <button onClick={() => render()}>인증 상태 갱신</button>
      </>
    );
  }
  const view = renderScreen(<Harness />, { route });
  const user = userEvent.setup();
  return {
    ...view,
    api,
    user,
    update: () => user.click(screen.getByRole("button", { name: "인증 상태 갱신" })),
  };
}
describe("공용 참고자료 검색과 정렬", () => {
  it("applies a draft explicitly and preserves server filters in history", async () => {
    const v = setup("/prompts/library?tab=contexts&contexts_page=2&contexts_sort=use_count:desc");
    await screen.findByText("검색 결과 자료");
    const input = screen.getByRole("textbox", { name: "참고자료 검색" });
    await v.user.type(input, "  한글  ");
    expect(v.api.calls).toHaveLength(1);
    await v.user.click(screen.getByRole("button", { name: "검색 적용" }));
    await waitFor(() =>
      expect(v.api.calls.at(-1)?.options.query).toMatchObject({
        q: "한글",
        sort: "use_count:desc",
        offset: 0,
      }),
    );
    expect(input).toHaveValue("한글");
    expect(screen.getByLabelText("현재 조회 주소")).toHaveTextContent("contexts_q");
    await v.user.click(screen.getByRole("button", { name: "이전 주소" }));
    await waitFor(() => expect(input).toHaveValue(""));
  });
  it("keeps search while changing state and page size and resets all conditions explicitly", async () => {
    const v = setup("/prompts/library?tab=contexts&contexts_q=%25_!&contexts_sort=name:desc&contexts_page=2");
    await screen.findByText("검색 결과 자료");
    await v.user.selectOptions(screen.getByRole("combobox", { name: "참고자료 사용 상태" }), "disabled");
    await waitFor(() =>
      expect(v.api.calls.at(-1)?.options.query).toMatchObject({
        q: "%_!",
        sort: "name:desc",
        state: "disabled",
        offset: 0,
      }),
    );
    await v.user.selectOptions(screen.getByRole("combobox", { name: "페이지당 표시 건수" }), "50");
    await waitFor(() => expect(v.api.calls.at(-1)?.options.query).toMatchObject({ q: "%_!", limit: 50 }));
    await v.user.click(screen.getByRole("button", { name: "조회 조건 초기화" }));
    await waitFor(() =>
      expect(v.api.calls.at(-1)?.options.query).toEqual({
        view: "metadata",
        state: "all",
        limit: 50,
        offset: 0,
      }),
    );
  });
  it("keeps sensitive input out of history and requests", async () => {
    const v = setup();
    await screen.findByText("검색 결과 자료");
    const input = screen.getByRole("textbox", { name: "참고자료 검색" });
    await v.user.type(input, "corp_" + "A".repeat(43));
    await v.user.click(screen.getByRole("button", { name: "검색 적용" }));
    expect(input).toHaveFocus();
    expect(v.api.calls).toHaveLength(1);
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("corp_");
    await screen.findByText(/비밀값과 제어 문자/);
  });
  it("supports three server sort criteria without sorting only the displayed page", async () => {
    const v = setup();
    await screen.findByText("검색 결과 자료");
    await v.user.click(screen.getByRole("button", { name: "다중 정렬" }));
    const dialog = within(screen.getByRole("dialog", { name: "다중 정렬 설정" }));
    const add = dialog.getByRole("button", { name: "정렬 기준 추가" });
    await v.user.click(add);
    await v.user.click(add);
    await v.user.click(add);
    expect(add).toBeDisabled();
    await v.user.click(dialog.getByRole("button", { name: "정렬 적용" }));
    await waitFor(() =>
      expect(v.api.calls.at(-1)?.options.query).toMatchObject({
        sort: "key:asc,name:asc,enabled:asc",
        offset: 0,
      }),
    );
  });
  it.each(["contexts_sort=name:up", "contexts_sort=name:asc,name:desc", "contexts_q=a&contexts_q=b"])(
    "blocks malformed route %s until explicit reset",
    async (query) => {
      const v = setup("/prompts/library?tab=contexts&" + query);
      await screen.findByText(/검색·정렬 조건이 올바르지/);
      expect(v.api.calls).toEqual([]);
      await v.user.click(screen.getByRole("button", { name: "조회 조건 초기화" }));
      await screen.findByText("검색 결과 자료");
    },
  );
  it("does not silently broaden an unsupported filtered deep link", async () => {
    runtime.version = "v0.86.130";
    const v = setup("/prompts/library?tab=contexts&contexts_q=한글");
    await screen.findByText(/검색과 정렬은 백엔드 v0.86.134 이상/);
    expect(v.api.calls).toEqual([]);
    await v.user.click(screen.getByRole("button", { name: "조회 조건 초기화" }));
    await screen.findByText("검색 결과 자료");
    expect(screen.queryByRole("textbox", { name: "참고자료 검색" })).not.toBeInTheDocument();
  });
  it("drops an unsent draft when the authenticated owner changes", async () => {
    const v = setup();
    await screen.findByText("검색 결과 자료");
    await v.user.type(screen.getByRole("textbox", { name: "참고자료 검색" }), "이전 계정 초안");
    runtime.id = "another-reader";
    await v.update();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "참고자료 검색" })).toHaveValue(""));
  });
  it("preserves code-point boundaries and rejects malformed search/sort input", () => {
    expect(validContextSearch("😀".repeat(200), [])).toBe(true);
    expect(validContextSearch("가".repeat(201), [])).toBe(false);
    expect(validContextSearch("👩‍💻", [])).toBe(true);
    expect(validContextSearch("a\nb", [])).toBe(false);
    expect(readContextSearch(new URLSearchParams("contexts_sort=use_count:desc,name:asc"), []).sorts).toEqual(
      [
        { columnId: "count", direction: "desc" },
        { columnId: "name", direction: "asc" },
      ],
    );
  });
});
