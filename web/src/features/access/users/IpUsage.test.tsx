import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import * as csv from "@/shared/utils/csv";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { ipFixture, ipDetailFixture } from "@/test/ip-usage";
import { IpsTab } from "./IpsTab";

const runtime = vi.hoisted(() => ({
  id: "ip-user-a",
  team: "team-a",
  role: "admin",
  scopes: ["admin:read", "observability:read"],
  permitted: true,
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: runtime.id, team_id: runtime.team },
        role: runtime.role,
        scopes: runtime.scopes,
      }),
  };
});
function Location() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{useLocation().search}</output>
      <button onClick={() => navigate(-1)}>테스트 뒤로</button>
      <button onClick={() => navigate(1)}>테스트 앞으로</button>
    </>
  );
}
function setup(extra: Record<string, ApiHandler> = {}, route = "/access/users?tab=ips") {
  const api = mockApi({
    "GET /admin/ips": () => ({ ips: [ipFixture()] }),
    "GET /admin/ips/2001%3A0db8%3A%3A1": () => ipDetailFixture(),
    ...extra,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Location />
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route
              path="/access/users"
              element={
                <FeatureAccessContext.Provider
                  value={{
                    featureId: "access.users",
                    permitted: runtime.permitted,
                    readOnly: runtime.readOnly,
                    status: "preview",
                  }}
                >
                  <main id="main-content" tabIndex={-1}>
                    <h1>IP 사용량</h1>
                    <IpsTab />
                  </main>
                </FeatureAccessContext.Provider>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, client, refresh: () => view.rerender(tree()) };
}
beforeEach(() => {
  runtime.id = "ip-user-a";
  runtime.team = "team-a";
  runtime.role = "admin";
  runtime.scopes = ["admin:read", "observability:read"];
  runtime.permitted = true;
  runtime.readOnly = false;
  tokenStore.clearAll();
  localStorage.clear();
});
it("restores search, ordering, page and exact IPv6 detail independently of the filtered list", async () => {
  setup(
    {},
    "/access/users?tab=ips&ips_q=no-match&ips_sort=cost:desc,ip:asc&ip=2001%3A0db8%3A%3A1&ip_view=distribution&ip_models_page=4",
  );
  const dialog = await screen.findByRole("dialog", { name: "2001:0db8::1" });
  expect(await within(dialog).findByText("모델-35")).toBeVisible();
  expect(within(dialog).getByText("key_public_id")).toBeVisible();
  expect(screen.getByTestId("location")).toHaveTextContent("ip_models_page=4");
  expect(screen.getByText("검색 조건에 맞는 항목이 없습니다.")).toBeInTheDocument();
});
it("keeps every returned model accessible and renders real date and request cost contracts", async () => {
  const user = userEvent.setup();
  const app = setup({}, "/access/users?tab=ips&ip=2001%3A0db8%3A%3A1");
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("2026-11-12")).toBeVisible();
  await user.click(within(dialog).getByRole("tab", { name: "최근 요청" }));
  expect(await within(dialog).findByText("공개 모델")).toBeVisible();
  expect(within(dialog).getByRole("link", { name: "req_public_ip" })).toHaveAttribute(
    "href",
    "/observability/requests?ip=2001%3A0db8%3A%3A1&request_id=req_public_ip",
  );
  expect(
    JSON.stringify(
      app.client.getQueryData(
        app.client
          .getQueryCache()
          .findAll()
          .find((query) => query.queryKey.includes("detail"))?.queryKey ?? [],
      ),
    ),
  ).not.toContain("PRIVATE_");
  expect(within(dialog).getByRole("link", { name: "기존 관리자에서 보기" })).toHaveAttribute(
    "href",
    "/admin#/ips/2001%3A0db8%3A%3A1",
  );
});
it("keeps initial failure separate from zero, then retries an empty result", async () => {
  let fail = true;
  const user = userEvent.setup();
  setup({
    "GET /admin/ips": () => {
      if (fail) throw apiFailure("private database message");
      return { ips: [] };
    },
  });
  await screen.findByText("IP 목록을(를) 불러오지 못했습니다.");
  expect(screen.queryByRole("region", { name: "조회된 IP 사용량 요약" })).not.toBeInTheDocument();
  expect(screen.queryByText("private database message")).not.toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("기록된 항목이 없습니다.")).toBeVisible();
});
it("does not label a missing child collection or metric as empty or zero", async () => {
  setup(
    { "GET /admin/ips/2001%3A0db8%3A%3A1": () => ({ stats: { ip: "2001:0db8::1", requests: 0 } }) },
    "/access/users?tab=ips&ip=2001%3A0db8%3A%3A1",
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findAllByText(/이 항목의 집계가 응답에 없습니다/u);
  expect(within(dialog).getAllByText("미확인").length).toBeGreaterThan(0);
  expect(within(dialog).queryByText("기록된 항목이 없습니다.")).not.toBeInTheDocument();
});
it("preserves last good data on a transient error, but hides it on a permission denial", async () => {
  let status = 0;
  const app = setup({
    "GET /admin/ips": () => {
      if (status) throw apiFailure("private message", status);
      return { ips: [ipFixture()] };
    },
  });
  await screen.findByRole("link", { name: "2001:0db8::1" });
  status = 500;
  await act(async () => {
    await app.client.invalidateQueries({ queryKey: ["access", "ips"] });
  });
  expect(await screen.findByText(/마지막으로 확인된 값을 표시합니다/u)).toBeVisible();
  expect(screen.getByRole("link", { name: "2001:0db8::1" })).toBeVisible();
  status = 403;
  await act(async () => {
    await app.client.invalidateQueries({ queryKey: ["access", "ips"] });
  });
  await screen.findByText("IP 사용량 조회 권한을 다시 확인하세요.");
  expect(screen.queryByRole("link", { name: "2001:0db8::1" })).not.toBeInTheDocument();
  expect(app.client.getQueryCache().findAll()).toHaveLength(0);
});
it.each(["account", "team", "role", "permission", "feature", "session"])(
  "discards late results across %s ownership changes",
  async (change) => {
    let done!: (data: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      done = resolve;
    });
    let initial = true;
    const app = setup({ "GET /admin/ips": () => (initial ? pending : { ips: [ipFixture("192.0.2.5")] }) });
    await waitFor(() => expect(app.api.calls.length).toBe(1));
    initial = false;
    if (change === "account") runtime.id = "ip-user-b";
    if (change === "team") runtime.team = "team-b";
    if (change === "role") runtime.role = "viewer";
    if (change === "permission") runtime.scopes = [];
    if (change === "feature") runtime.permitted = false;
    await act(async () => {
      if (change === "session") tokenStore.clearAll();
      app.refresh();
    });
    await act(async () => {
      done({ ips: [ipFixture("192.0.2.200")] });
      await pending;
    });
    expect(screen.queryByText("192.0.2.200")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        app.client
          .getQueryCache()
          .findAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("192.0.2.200");
  },
);
it("retains read-only queries while hiding request links without observability permission", async () => {
  const app = setup({}, "/access/users?tab=ips&ip=2001%3A0db8%3A%3A1&ip_view=requests");
  await screen.findByRole("link", { name: "req_public_ip" });
  runtime.readOnly = true;
  app.refresh();
  expect(screen.getByRole("link", { name: "req_public_ip" })).toBeVisible();
  runtime.scopes = ["admin:read"];
  app.refresh();
  await screen.findByText("공개 모델");
  expect(screen.queryByRole("link", { name: "req_public_ip" })).not.toBeInTheDocument();
  expect(app.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});
it("exports the full filtered metadata, protects formulas, and rejects secret searches before URL history", async () => {
  const save = vi.spyOn(csv, "downloadCsv").mockImplementation(() => undefined);
  const user = userEvent.setup();
  const detail = ipDetailFixture();
  detail.by_model = detail.by_model.map((row, index) => (index === 0 ? { ...row, key: "=SUM(A1:A2)" } : row));
  setup(
    { "GET /admin/ips/2001%3A0db8%3A%3A1": () => detail },
    "/access/users?tab=ips&ip=2001%3A0db8%3A%3A1&ip_view=distribution",
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("=SUM(A1:A2)");
  const form = within(dialog).getByRole("form", { name: "모델별 사용량 검색" });
  await user.click(within(form).getByRole("button", { name: "검색 결과 CSV" }));
  expect(save.mock.calls[0]?.[1]).toContain("모델-35");
  expect(save.mock.calls[0]?.[1]).toContain("'=SUM(A1:A2)");
  const input = within(form).getByRole("textbox");
  await user.type(input, "vc_sk_private_fixture_for_search");
  await user.click(within(form).getByRole("button", { name: "검색" }));
  expect(await screen.findByText("비밀값 없이 200자 이내로 입력하세요.")).toBeVisible();
  expect(screen.getByTestId("location")).not.toHaveTextContent("vc_sk_");
  expect(input).toHaveFocus();
});
it("restores the opener after closing detail and supports browser history", async () => {
  const user = userEvent.setup();
  setup();
  const opener = await screen.findByRole("link", { name: "2001:0db8::1" });
  await user.click(opener);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "테스트 뒤로" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
});
it("has no automated accessibility violations in the IP list", async () => {
  const app = setup();
  await screen.findByRole("link", { name: "2001:0db8::1" });
  expect((await axe.run(app.container)).violations).toEqual([]);
});
