import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppPage } from "./AppPage";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";
import { workAppReadFixture } from "@/test/work-app-fixtures";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => ({ ...testAuth(), credentialPrefixes: ["corp_"] }) };
});
const rows = Array.from({ length: 37 }, (_, index) => ({
  id: `app-${String(index).padStart(2, "0")}`,
  title: `업무 앱 ${String(index).padStart(2, "0")}`,
  status: index % 2 === 0 ? "active" : "archived",
  description: "설명",
  components: [{ label: `구성 ${index}`, kind: "skill", ref: "detail-only-ref" }],
}));
let navigate: (value: string) => void;
function Host() {
  const location = useLocation(),
    move = useNavigate();
  useLayoutEffect(() => {
    navigate = move;
  }, [move]);
  return (
    <FeatureAccessHarness featureId="agents.apps">
      <output aria-label="현재 조회 주소">{location.search}</output>
      <AppPage />
    </FeatureAccessHarness>
  );
}
function setup(route = "/agents/apps", handler?: ApiHandler) {
  const api = mockApi({
    "GET /admin/apps": handler ?? (({ query }) => workAppReadFixture(rows, query)),
  });
  const view = renderScreen(<Host />, { route });
  return { api, view };
}
const calls = (api: ReturnType<typeof mockApi>, view = "page") =>
  api.calls.filter((call) => (call.options.query as { view?: string })?.view === view);

describe("업무 앱 서버 페이지와 독립 상세", () => {
  it("25행만 표시하고 다음 페이지와 크기를 서버 쿼리에 반영한다", async () => {
    const user = userEvent.setup(),
      { api } = setup();
    await screen.findByText("업무 앱 00");
    const table = screen.getByRole("table", { name: "AI 업무 앱 목록" });
    expect(within(table).getAllByRole("row")).toHaveLength(26);
    expect(screen.queryByText("업무 앱 25")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("업무 앱 25");
    expect(screen.queryByText("업무 앱 00")).not.toBeInTheDocument();
    expect(calls(api).map((call) => call.options.query)).toEqual([
      { view: "page", limit: 25, offset: 0 },
      { view: "page", limit: 25, offset: 25 },
    ]);
    expect(screen.getByLabelText("현재 조회 주소")).toHaveTextContent("page=2");
    await user.selectOptions(screen.getByRole("combobox", { name: "페이지당 표시 건수" }), "10");
    await waitFor(() =>
      expect(calls(api).at(-1)?.options.query).toEqual({ view: "page", limit: 10, offset: 0 }),
    );
  });
  it("주소의 필터·다중 정렬·크기·페이지를 첫 요청에 적용한다", async () => {
    const { api } = setup("/agents/apps?q=업무 앱&status=active&sort=status:desc,title:asc&size=10&page=2");
    await screen.findByText("업무 앱 20");
    expect(calls(api)[0]?.options.query).toEqual({
      view: "page",
      q: "업무 앱",
      status: "active",
      sort: "status:desc,title:asc",
      limit: 10,
      offset: 10,
    });
    expect(screen.getByLabelText("업무 앱 검색")).toHaveValue("업무 앱");
    expect(screen.getByLabelText("상태")).toHaveValue("active");
  });
  it("검색 제출 때 첫 페이지로 돌아가고 전체 데이터에서 일치 항목을 찾는다", async () => {
    const user = userEvent.setup(),
      { api } = setup("/agents/apps?page=2");
    await screen.findByText("업무 앱 25");
    await user.type(screen.getByLabelText("업무 앱 검색"), "업무 앱 03");
    expect(calls(api)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "검색 적용" }));
    await screen.findByText("업무 앱 03");
    expect(calls(api).at(-1)?.options.query).toEqual({ view: "page", limit: 25, offset: 0, q: "업무 앱 03" });
    expect(screen.getByLabelText("현재 조회 주소")).not.toHaveTextContent("page=");
  });
  it("현재 페이지 밖의 정의를 ID로 조회하고 닫아도 목록 상태를 유지한다", async () => {
    const user = userEvent.setup(),
      { api } = setup("/agents/apps?page=2&size=10&app=app-36");
    const detail = await screen.findByRole("dialog", { name: "업무 앱 36" });
    expect(within(detail).getByText("구성 36")).toBeVisible();
    expect(calls(api, "detail")[0]?.options.query).toEqual({ view: "detail", id: "app-36" });
    expect(calls(api)[0]?.options.query).toEqual({ view: "page", limit: 10, offset: 10 });
    await user.click(within(detail).getByRole("button", { name: "패널 닫기" }));
    expect(screen.getByLabelText("현재 조회 주소")).toHaveTextContent("page=2&size=10");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("목록 실패 중에도 상세는 독립 조회하며 상세 실패는 요청 ID와 재시도를 제공한다", async () => {
    const user = userEvent.setup();
    let failed = true;
    setup("/agents/apps?app=app-36", ({ query }) => {
      if ((query as { view: string }).view === "page") throw apiFailure("list failed", 500, "page-id");
      if (failed) throw apiFailure("detail failed", 500, "detail-id");
      return workAppReadFixture(rows, query);
    });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("detail-id");
    expect(within(dialog).queryByRole("button", { name: "수정" })).not.toBeInTheDocument();
    failed = false;
    await user.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("dialog", { name: "업무 앱 36" })).toBeVisible();
  });
  it("없는 상세와 잘못된 응답 ID를 구분하며 변경 버튼을 열지 않는다", async () => {
    setup("/agents/apps?app=missing");
    expect(await screen.findByText("앱을 찾을 수 없습니다.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "수정" })).not.toBeInTheDocument();
  });
  it("다른 ID 응답을 선택한 정의로 사용하지 않는다", async () => {
    setup("/agents/apps?app=app-36", ({ query }) =>
      (query as { view: string }).view === "detail"
        ? workAppReadFixture(rows, { view: "detail", id: "app-00" })
        : workAppReadFixture(rows, query),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 응답 형식을 확인할 수 없습니다.");
    expect(screen.queryByRole("button", { name: "수정" })).not.toBeInTheDocument();
  });
  it("이전 상세의 늦은 응답을 새 선택에 표시하지 않는다", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { api } = setup("/agents/apps?app=app-00", ({ query }) =>
      (query as { view: string; id?: string }).view === "detail" && (query as { id: string }).id === "app-00"
        ? pending
        : workAppReadFixture(rows, query),
    );
    await waitFor(() => expect(calls(api, "detail")).toHaveLength(1));
    act(() => navigate("/agents/apps?app=app-36"));
    await screen.findByRole("dialog", { name: "업무 앱 36" });
    await act(async () => {
      finish(workAppReadFixture(rows, { view: "detail", id: "app-00" }));
      await pending;
    });
    expect(screen.getByRole("dialog", { name: "업무 앱 36" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "업무 앱 00" })).not.toBeInTheDocument();
  });
  it("상세 403은 목록·상세 캐시와 열린 변경 작업을 함께 폐기한다", async () => {
    const { view } = setup("/agents/apps?app=app-36", ({ query }) => {
      if ((query as { view: string }).view === "detail") throw apiFailure("denied", 403);
      return workAppReadFixture(rows, query);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("조회 권한");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes("app-workspace")),
    ).toHaveLength(0);
  });
  it("마운트 해제 후 정의 본문을 쿼리 캐시에 남기지 않는다", async () => {
    const { view } = setup("/agents/apps?app=app-36");
    await screen.findByRole("dialog", { name: "업무 앱 36" });
    view.unmount();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes("app-workspace")),
    ).toHaveLength(0);
  });
});
