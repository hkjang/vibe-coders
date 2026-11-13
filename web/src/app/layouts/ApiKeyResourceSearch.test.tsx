import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({
  version: "v0.86.101",
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
      kind: "api_key",
      status: "ok",
      limited: false,
      items: [{ kind: "api_key", id: "key_named", title: "정산 자동화 키" }],
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
  runtime.version = "v0.86.101";
  runtime.team = "alpha";
  runtime.hidden = false;
  runtime.scopes = ["admin:read"];
});

it("API 키 이름 검색은 조회 권한으로 지원되는 종류만 보내고 정확한 상세로 이동한다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(await screen.findByRole("option", { name: /정산 자동화 키/ })).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { query: "정산", kinds: ["api_key", "workflow", "team", "account"] },
  });
  expect(within(screen.getByRole("option")).getByText("API 키", { exact: true })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(view.go).toHaveBeenCalledWith("/access/users?api_key_id=key_named&tab=keys");
  view.unmount();
  await waitFor(() =>
    expect(view.client.getQueryCache().findAll({ queryKey: ["resource-search"] })).toHaveLength(0),
  );
});

it.each(["v0.86.100", "v0.86.99"])("이전 서버 %s에는 API 키 검색을 요청하지 않는다", async (version) => {
  runtime.version = version;
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect((request.mock.calls[0]?.[1] as { body: { kinds: string[] } }).body.kinds).not.toContain("api_key");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
it.each(["", "bad/id", "bad id", "x".repeat(513), "corp_" + "x".repeat(43)])(
  "잘못된 키 식별자로 상세 주소를 만들지 않는다",
  (id) => {
    expect(resourceSearchPath("api_key", id, ["corp_"])).toBeUndefined();
  },
);
