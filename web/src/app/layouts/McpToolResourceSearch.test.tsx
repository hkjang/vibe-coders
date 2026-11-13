import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({
  version: "v0.86.96",
  team: "alpha",
  hidden: false,
  scopes: ["admin:read", "observability:read"],
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
      .filter((feature) => feature.featureId === "mcp.overview")
      .map((feature) => (runtime.hidden ? { ...feature, status: "hidden" } : feature)),
  }),
}));
const response = {
  request_id: "tool-search-request",
  groups: [
    {
      kind: "mcp_tool",
      status: "ok",
      limited: false,
      items: [
        { kind: "mcp_tool", id: "정산/조회&결과", title: "정산/조회&결과", server_label: "서버/a&b" },
        { kind: "mcp_tool", id: "정산/조회&결과", title: "정산/조회&결과", server_label: "server-b" },
      ],
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
  Object.assign(runtime, {
    version: "v0.86.96",
    team: "alpha",
    hidden: false,
    scopes: ["admin:read", "observability:read"],
  });
});

it("같은 이름의 도구는 서버를 구분하고 키보드로 정확한 서버·도구 필터를 연다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup();
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "정산" } });
  expect(await screen.findByRole("option", { name: /서버\/a&b/ })).toBeVisible();
  expect(screen.getByRole("option", { name: /server-b/ })).toBeVisible();
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { query: "정산", kinds: ["mcp_upstream", "mcp_tool"] },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  const target = new URL(view.go.mock.calls[0]?.[0] as string, "https://console.invalid");
  expect(target.pathname).toBe("/mcp");
  expect(Object.fromEntries(target.searchParams)).toEqual({
    tab: "tools",
    server: "서버/a&b",
    tool: "정산/조회&결과",
    mcp_only: "1",
  });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    new URL(view.go.mock.calls[1]?.[0] as string, "https://console.invalid").searchParams.get("server"),
  ).toBe("server-b");
});

it.each(["old", "hidden", "admin-only", "write-only"])(
  "%s 상태에서는 도구 검색과 반환된 결과 이동을 허용하지 않는다",
  async (mode) => {
    if (mode === "old") runtime.version = "v0.86.95";
    if (mode === "hidden") runtime.hidden = true;
    if (mode === "admin-only") runtime.scopes = ["admin:read"];
    if (mode === "write-only") runtime.scopes = ["admin:read", "mcp:admin"];
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    const view = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    if (mode === "old") {
      await waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { kinds: ["mcp_upstream"] } });
    } else expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(view.go).not.toHaveBeenCalled();
  },
);

it("팀 변경 후 늦게 끝난 도구 검색은 결과와 주소를 남기지 않는다", async () => {
  let release!: (value: typeof response) => void;
  const pending = new Promise<typeof response>((done) => {
    release = done;
  });
  const request = vi.spyOn(apiClient, "request").mockReturnValue(pending);
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
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
  await waitFor(() =>
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["resource-search"] })
        .every((q) => q.state.data === undefined),
    ).toBe(true),
  );
});

it("도구 주소는 서버를 요구하고 비밀값·제어문자·과도한 길이를 거부한다", () => {
  for (const [id, server] of [
    ["tool", undefined],
    ["tool", ""],
    ["tool", " bad"],
    ["bad\nname", "server"],
    ["tool", "bad\u200bserver"],
    ["x".repeat(257), "server"],
    ["tool", "x".repeat(513)],
    ["tool", `corp_${"x".repeat(43)}`],
  ]) {
    expect(resourceSearchPath("mcp_tool", id ?? "", ["corp_"], server)).toBeUndefined();
  }
  expect(resourceSearchPath("mcp_tool", "read", [], "(none)")).toContain("server=%28none%29");
});
