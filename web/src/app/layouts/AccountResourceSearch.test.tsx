import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({
  version: "v0.86.90",
  team: "alpha",
  hidden: false,
  scopes: ["admin:read"],
}));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: runtime.version,
    legacyFallback: true,
    credentialPrefixes: ["corp_"],
    user: {
      id: "reader",
      role: "readonly_admin",
      roles: ["readonly_admin"],
      team_id: runtime.team,
      scopes: runtime.scopes,
    },
    features: migrationRegistry
      .filter((feature) => ["access.users", "agents.workflows"].includes(feature.featureId))
      .map((feature) =>
        runtime.hidden && feature.featureId === "access.users" ? { ...feature, status: "hidden" } : feature,
      ),
  }),
}));

const response = {
  request_id: "account-search-request",
  groups: [
    {
      kind: "account",
      status: "ok",
      limited: false,
      items: [{ kind: "account", id: "사용자/a&b", title: "정산 담당자" }],
    },
  ],
};
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const go = vi.fn();
  const tree = () => (
    <QueryClientProvider client={client}>
      <ResourceSearchPanel go={go} />
    </QueryClientProvider>
  );
  return { ...render(tree()), go, tree, client };
}
beforeEach(() => {
  runtime.version = "v0.86.90";
  runtime.team = "alpha";
  runtime.hidden = false;
  runtime.scopes = ["admin:read"];
});

it("계정 이름 검색은 조회 권한으로 지원되는 종류만 보내고 정확한 상세로 이동한다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(await screen.findByRole("option", { name: /정산 담당자/ })).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { query: "정산", kinds: ["workflow", "team", "account"] },
  });
  expect(screen.getByText("로그인 계정", { exact: true })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(view.go).toHaveBeenCalledWith(
    "/access/users/accounts?account_id=%EC%82%AC%EC%9A%A9%EC%9E%90%2Fa%26b",
  );
  view.unmount();
  await waitFor(() =>
    expect(view.client.getQueryCache().findAll({ queryKey: ["resource-search"] })).toHaveLength(0),
  );
});

it.each(["old-backend", "hidden-feature"])(
  "계정 검색을 지원하지 않는 %s 상태는 서버가 반환한 결과도 숨긴다",
  async (reason) => {
    runtime.version = reason === "old-backend" ? "v0.86.89" : "v0.86.90";
    runtime.hidden = reason === "hidden-feature";
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    const view = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0개의 자원을 찾았습니다."));
    const options = request.mock.calls[0]?.[1] as { body?: { kinds?: string[] } };
    expect(options.body?.kinds).not.toContain("account");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(view.go).not.toHaveBeenCalled();
  },
);

it("보안 조회 권한만으로는 로그인 계정을 검색하지 않는다", () => {
  runtime.scopes = ["security:read"];
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(screen.getByRole("status")).toHaveTextContent("검색할 수 있는 자원 권한이 없습니다.");
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(view.go).not.toHaveBeenCalled();
});

it("팀이 바뀌면 이전 계정 검색의 지연 응답과 이동 권한을 폐기한다", async () => {
  let release: (value: typeof response) => void = () => undefined;
  const pending = new Promise<typeof response>((resolve) => {
    release = resolve;
  });
  const request = vi.spyOn(apiClient, "request").mockReturnValue(pending);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const previousKeys = view.client
    .getQueryCache()
    .findAll({ queryKey: ["resource-search"] })
    .map((query) => query.queryKey);
  expect(previousKeys.length).toBeGreaterThan(0);
  runtime.team = "beta";
  view.rerender(view.tree());
  await act(async () => {
    release(response);
    await pending;
  });
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(view.go).not.toHaveBeenCalled();
  await waitFor(() => {
    for (const queryKey of previousKeys)
      expect(view.client.getQueryCache().find({ queryKey, exact: true })).toBeUndefined();
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["resource-search"] })
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
});

it("계정 상세 주소는 비밀값·제어문자·과도하게 긴 ID를 사용하지 않는다", () => {
  for (const id of ["", "account\nname", "account\u200bname", "x".repeat(513), `corp_${"x".repeat(43)}`]) {
    expect(resourceSearchPath("account", id, ["corp_"])).toBeUndefined();
  }
});
