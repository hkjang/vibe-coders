import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { FilterSuggestions } from "./FilterSuggestions";

const auth = vi.hoisted(() => ({ id: "reader", team: "team-a", raw: true, scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ user: { id: auth.id, team_id: auth.team }, scopes: auth.scopes, rawPromptView: auth.raw }),
  };
});
beforeEach(() => Object.assign(auth, { id: "reader", team: "team-a", raw: true, scopes: ["admin:read"] }));
afterEach(() => vi.restoreAllMocks());

function start(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (active: boolean) => (
    <QueryClientProvider client={client}>
      <FeatureAccessContext.Provider
        value={{ featureId: "observability.requests", permitted: true, readOnly: true }}
      >
        <FilterSuggestions enabled={active} field="model" id="test-models" />
      </FeatureAccessContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree(enabled));
  return {
    ...view,
    client,
    values: () => Array.from(view.container.querySelectorAll("option")).map((option) => option.value),
    change: (active = true) => view.rerender(tree(active)),
  };
}
function pending() {
  let resolve!: (value: { values: string[] }) => void;
  const promise = new Promise<{ values: string[] }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("입력창에 포커스하기 전에는 자동완성을 조회하지 않는다", async () => {
  const api = mockApi({ "GET /admin/suggest": () => ({ values: ["model-a"] }) });
  const view = start(false);
  expect(api.calls).toHaveLength(0);
  expect(view.values()).toEqual([]);
  view.change(true);
  await waitFor(() => expect(view.values()).toEqual(["model-a"]));
  expect(api.calls).toHaveLength(1);
});

it("같은 계정의 팀이 바뀌면 포커스 전에도 이전 팀의 캐시를 표시하지 않는다", async () => {
  const api = mockApi({ "GET /admin/suggest": () => ({ values: [`${auth.team}-only`] }) });
  const view = start();
  await waitFor(() => expect(view.values()).toEqual(["team-a-only"]));
  auth.team = "team-b";
  view.change(false);
  await waitFor(() => expect(view.values()).toEqual([]));
  expect(api.calls).toHaveLength(1);
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .some((query) => (JSON.stringify(query.state.data) ?? "").includes("team-a-only")),
  ).toBe(false);
  view.change(true);
  await waitFor(() => expect(view.values()).toEqual(["team-b-only"]));
});

it("원문 조회 권한만 바뀌어도 새로 마스킹한 목록을 받을 때까지 이전 값을 숨긴다", async () => {
  const next = pending();
  mockApi({ "GET /admin/suggest": () => (auth.raw ? { values: ["privileged-only"] } : next.promise) });
  const view = start();
  await waitFor(() => expect(view.values()).toEqual(["privileged-only"]));
  auth.raw = false;
  view.change();
  await waitFor(() => expect(view.values()).toEqual([]));
  await act(async () => next.resolve({ values: ["masked-model"] }));
  await waitFor(() => expect(view.values()).toEqual(["masked-model"]));
});

it("늦은 이전 팀 응답은 새 팀과 다시 돌아온 계정에 채워 넣지 않는다", async () => {
  const old = pending();
  let first = true;
  const api = mockApi({
    "GET /admin/suggest": () => {
      if (first) {
        first = false;
        return old.promise;
      }
      return { values: [`fresh-${auth.team}`] };
    },
  });
  const view = start();
  await waitFor(() => expect(api.calls).toHaveLength(1));
  auth.team = "team-b";
  view.change();
  await waitFor(() => expect(view.values()).toEqual(["fresh-team-b"]));
  await act(async () => old.resolve({ values: ["retired-team-a"] }));
  expect(view.values()).toEqual(["fresh-team-b"]);
  auth.team = "team-a";
  view.change();
  await waitFor(() => expect(view.values()).toEqual(["fresh-team-a"]));
});

it("조회 권한이 사라지면 이전 추천 값을 지우고 새 요청을 보내지 않는다", async () => {
  const api = mockApi({ "GET /admin/suggest": () => ({ values: ["authorized-only"] }) });
  const view = start();
  await waitFor(() => expect(view.values()).toEqual(["authorized-only"]));
  auth.scopes = [];
  view.change();
  await waitFor(() => expect(view.values()).toEqual([]));
  await act(async () => {
    await view.client.refetchQueries();
  });
  expect(api.calls).toHaveLength(1);
});

for (const status of [401, 403]) {
  it(`${status} 조회 거부 뒤에는 이전 값을 지우고 명시 재조회로만 복구한다`, async () => {
    let denied = false;
    const api = mockApi({
      "GET /admin/suggest": () => {
        if (denied) throw apiFailure("private error", status);
        return { values: ["current-model"] };
      },
    });
    const view = start();
    await waitFor(() => expect(view.values()).toEqual(["current-model"]));
    denied = true;
    await act(async () => {
      await view.client.refetchQueries();
    });
    await waitFor(() => expect(view.values()).toEqual([]));
    const calls = api.calls.length;
    denied = false;
    await act(async () => {
      await view.client.refetchQueries();
    });
    expect(api.calls).toHaveLength(calls);
    expect(view.container).not.toHaveTextContent("private error");
    await userEvent.click(screen.getByRole("button", { name: "모델 자동완성 다시 불러오기" }));
    await waitFor(() => expect(view.values()).toEqual(["current-model"]));
  });
}

it("쓰기 권한만 바뀌면 현재 읽기 목록을 유지하며 중복 조회하지 않는다", async () => {
  const api = mockApi({ "GET /admin/suggest": () => ({ values: ["readable-model"] }) });
  const view = start();
  await waitFor(() => expect(view.values()).toEqual(["readable-model"]));
  auth.scopes = ["admin:read", "admin:write"];
  view.change();
  expect(view.values()).toEqual(["readable-model"]);
  expect(api.calls).toHaveLength(1);
});

it("일시 조회 실패 시 이전 추천을 숨기고 명시 재조회로 복구한다", async () => {
  let failing = false;
  mockApi({
    "GET /admin/suggest": () => {
      if (failing) throw apiFailure("private backend diagnostic", 503);
      return { values: ["current-model"] };
    },
  });
  const view = start();
  await waitFor(() => expect(view.values()).toEqual(["current-model"]));
  failing = true;
  await act(async () => {
    await view.client.refetchQueries();
  });
  await waitFor(() => expect(view.values()).toEqual([]));
  expect(view.container).not.toHaveTextContent("private backend diagnostic");
  failing = false;
  await userEvent.click(screen.getByRole("button", { name: "모델 자동완성 다시 불러오기" }));
  await waitFor(() => expect(view.values()).toEqual(["current-model"]));
});
