import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const state = vi.hoisted(() => ({ version: "v0.86.103", scopes: ["routing:read"], hidden: false }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: state.version,
    legacyFallback: true,
    credentialPrefixes: ["corp_"],
    user: { id: "routing-reader", role: "admin", roles: ["admin"], team_id: "alpha", scopes: state.scopes },
    features: migrationRegistry
      .filter((f) => f.featureId === "routing.rules")
      .map((f) => (state.hidden ? { ...f, status: "hidden" } : f)),
  }),
}));
const result = {
  request_id: "routing-search",
  groups: [
    {
      kind: "routing_rule",
      status: "ok",
      limited: false,
      items: [{ kind: "routing_rule", id: "분기/정산?%#", title: "정산 모델" }],
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
beforeEach(() => Object.assign(state, { version: "v0.86.103", scopes: ["routing:read"], hidden: false }));
it("라우팅 조회 권한으로 ID·모델 선택자를 검색하고 정확한 한글 상세 주소를 연다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(result);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(await screen.findByRole("option", { name: /정산 모델/ })).toBeVisible();
  expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { query: "정산", kinds: ["routing_rule"] } });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  const target = new URL(view.go.mock.calls[0]?.[0] as string, "https://console.invalid");
  expect(target.pathname).toBe("/routing/rules");
  expect(target.searchParams.get("rule_id")).toBe("분기/정산?%#");
  view.unmount();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
});
it.each(["old-server", "scope", "hidden"])("%s 전환은 검색과 기존 결과를 제거한다", async (kind) => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(result);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await screen.findByRole("option");
  if (kind === "old-server") state.version = "v0.86.102";
  else if (kind === "scope") state.scopes = ["admin:read"];
  else state.hidden = true;
  view.rerender(view.tree());
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(["", " padded", "a\u200bb", "x".repeat(513), "corp_" + "x".repeat(43)])(
  "안전하지 않은 ID로 상세 주소를 만들지 않는다",
  (id) => {
    expect(resourceSearchPath("routing_rule", id, ["corp_"])).toBeUndefined();
  },
);
