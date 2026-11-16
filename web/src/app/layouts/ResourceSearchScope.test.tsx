import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({ team: "alpha", scopes: ["admin:read", "security:read"] }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: "v0.86.100",
    legacyFallback: true,
    credentialPrefixes: ["corp_"],
    user: {
      id: "reader",
      role: "readonly_admin",
      roles: ["readonly_admin"],
      team_id: runtime.team,
      scopes: runtime.scopes,
    },
    features: migrationRegistry.filter((f) =>
      ["system.settings", "agents.workflows", "governance.policies"].includes(f.featureId),
    ),
  }),
}));
const setting = {
  kind: "setting",
  status: "ok",
  limited: true,
  items: [{ kind: "setting", id: "cache.enabled", title: "정산 캐시" }],
};
const workflow = {
  kind: "workflow",
  status: "ok",
  limited: false,
  items: [{ kind: "workflow", id: "billing-flow", title: "정산 흐름" }],
};
const policy = { kind: "policy", status: "unavailable", limited: false, items: [] };
const response = { request_id: "scope-search", groups: [workflow, policy, setting] };
function setup() {
  const go = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ResourceSearchPanel go={go} />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, go, client };
}
function choose(title: string) {
  fireEvent.click(screen.getByRole("button", { name: /^검색 대상:/ }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "검색할 자원 종류" })).getByRole("button", {
      name: title,
    }),
  );
}
beforeEach(() => {
  runtime.team = "alpha";
  runtime.scopes = ["admin:read", "security:read"];
});

it("검색 전 종류 선택은 호출하지 않고 선택한 종류만 조회하며 입력 초점을 복원한다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  setup();
  choose("시스템 설정");
  const input = screen.getByRole("combobox");
  expect(input).toHaveFocus();
  expect(screen.getByRole("button", { name: "검색 대상: 시스템 설정" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "정산" } });
  expect(await screen.findAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("정산 캐시");
  expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { query: "정산", kinds: ["setting"] } });
  expect(screen.getByRole("status")).not.toHaveTextContent("정책");
});

it("전체 결과의 표시와 키보드 이동 순서가 응답의 종류 순서와 무관하게 일치한다", async () => {
  vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup(),
    input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "정산" } });
  expect(await screen.findAllByRole("option")).toHaveLength(2);
  expect(screen.getAllByRole("option").map((item) => item.textContent)).toEqual([
    expect.stringContaining("정산 캐시"),
    expect.stringContaining("정산 흐름"),
  ]);
  expect(screen.getByRole("group", { name: "시스템 설정 1개 · 일부 결과" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("정책 (조회 실패)");
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(view.go.mock.calls).toEqual([
    ["/system/settings?setting=cache.enabled&tab=runtime"],
    ["/agents/workflows?workflow=billing-flow"],
  ]);
});

it("종류 전환 중 이전 결과를 숨기고 늦은 응답을 버리며 검색어를 보존한다", async () => {
  let resolve!: (data: typeof response) => void;
  const held = new Promise<typeof response>((done) => {
    resolve = done;
  });
  const request = vi.spyOn(apiClient, "request").mockReturnValueOnce(held).mockResolvedValue(response);
  const view = setup(),
    input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "정산" } });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0]?.[1]?.signal;
  choose("워크플로");
  expect(input).toHaveValue("정산");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(view.go).not.toHaveBeenCalled();
  expect(await screen.findByRole("option")).toHaveTextContent("정산 흐름");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve(response);
    await held;
  });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("정산 흐름");
  expect(request.mock.calls[1]?.[1]).toMatchObject({ body: { query: "정산", kinds: ["workflow"] } });
  choose("전체 자원");
  expect(await screen.findAllByRole("option")).toHaveLength(2);
  expect(request.mock.calls[2]?.[1]).toMatchObject({
    body: { query: "정산", kinds: ["setting", "workflow", "policy"] },
  });
});

it("실패한 종류만 선택해 재시도하고 다른 종류의 결과를 다시 사용하지 않는다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await screen.findAllByRole("option");
  choose("정책");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "자원 검색 다시 시도" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]?.[1]).toMatchObject({ body: { query: "정산", kinds: ["policy"] } });
});

it("계정 또는 조회 권한 변경은 검색 대상·입력·결과를 초기화한다", async () => {
  vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup();
  choose("정책");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await screen.findByRole("button", { name: "자원 검색 다시 시도" });
  runtime.team = "beta";
  runtime.scopes = ["admin:read"];
  view.rerender(view.tree());
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(screen.getByRole("button", { name: "검색 대상: 전체 자원" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^검색 대상:/ }));
  expect(screen.queryByRole("button", { name: "정책" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
