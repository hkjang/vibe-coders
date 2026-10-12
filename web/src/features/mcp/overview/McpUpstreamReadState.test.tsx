import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { McpUpstreamsTab } from "./McpUpstreamsTab";
import { apiFailure, mockApi } from "@/test/api";
import userEvent from "@testing-library/user-event";
import { FeatureAccessHarness } from "@/test/feature-access";

const auth = vi.hoisted(() => ({
  id: "reader-a",
  scopes: ["admin:read", "observability:read"],
  readOnly: false,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: auth.scopes, user: { id: auth.id } }) };
});
const server = {
  id: "search-server",
  name: "검색 서버",
  url: "https://example.invalid/mcp",
  enabled: true,
  has_auth: false,
  created_at: "",
  metadata: {},
};
const list = { upstreams: [server], discovery_errors: {} };
const emptyFlow = { steps: [], discovery_runs: [], recent_requests: [] };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/mcp?tab=upstreams&upstream=search-server"]}>
        <FeatureAccessHarness featureId="mcp.overview" readOnly={auth.readOnly}>
          <McpUpstreamsTab canWrite={true} />
        </FeatureAccessHarness>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, client };
}
beforeEach(() => {
  auth.id = "reader-a";
  auth.scopes = ["admin:read", "observability:read"];
  auth.readOnly = false;
  toasts.success.mockClear();
  toasts.error.mockClear();
});

it("preserves a pending confirmation but locks its action when the feature becomes read-only", async () => {
  auth.scopes.push("mcp:admin");
  const api = mockApi({
    "GET /admin/mcp/upstreams": () => list,
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
  });
  const view = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "사용 중지" }));
  expect(await screen.findByRole("dialog", { name: "업스트림 사용을 중지할까요?" })).toBeVisible();
  auth.readOnly = true;
  view.rerender(view.tree());
  const confirm = screen.getByRole("dialog", { name: "업스트림 사용을 중지할까요?" });
  expect(confirm).toBeVisible();
  expect(within(confirm).getByRole("button", { name: "사용 중지" })).toBeDisabled();
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it("preserves the edit draft while a read-only transition locks both click and direct submission", async () => {
  auth.scopes.push("mcp:admin");
  const api = mockApi({
    "GET /admin/mcp/upstreams": () => list,
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
  });
  const view = setup();
  const user = userEvent.setup();
  const edit = await screen.findByRole("button", { name: "수정" });
  await waitFor(() => expect(edit).toBeEnabled());
  await user.click(edit);
  const dialog = screen.getByRole("dialog", { name: "업스트림 수정" });
  const input = within(dialog).getByLabelText(/^표시 이름/);
  await user.clear(input);
  await user.type(input, "보존할 서버 초안");
  auth.readOnly = true;
  view.rerender(view.tree());
  expect(screen.getByRole("dialog", { name: "업스트림 수정" })).toBeVisible();
  expect(input).toHaveValue("보존할 서버 초안");
  expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
  const form = dialog.querySelector("form");
  if (!form) throw new Error("edit form missing");
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it("does not replay a probe and discards its late success after an owner change", async () => {
  auth.scopes.push("mcp:admin");
  let finish: (value: unknown) => void = () => undefined;
  const api = mockApi({
    "GET /admin/mcp/upstreams": () => list,
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
    "POST /admin/mcp/upstreams/search-server/probe": () =>
      new Promise((done) => {
        finish = done;
      }),
  });
  const view = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "연결 진단" }));
  await waitFor(() => expect(api.calls.filter((call) => call.key.startsWith("POST "))).toHaveLength(1));
  expect(
    api.spy.mock.calls.some(
      ([endpoint, options]) => endpoint.path.endsWith("/probe") && options?.retryUnauthorized === false,
    ),
  ).toBe(true);
  auth.id = "reader-b";
  view.rerender(view.tree());
  await act(async () =>
    finish({
      ok: true,
      tool_count: 1,
      prompt_count: 0,
      resource_count: 0,
      tools: [{ name: "previous-owner-tool" }],
      errors: {},
    }),
  );
  expect(screen.queryByText("연결 정상")).not.toBeInTheDocument();
  expect(screen.queryByText("previous-owner-tool")).not.toBeInTheDocument();
  expect(toasts.success).not.toHaveBeenCalled();
  expect(toasts.error).not.toHaveBeenCalled();
});

it("does not read MCP metadata or flow without the actual list scope", () => {
  auth.scopes = ["admin:read", "mcp:admin"];
  const api = mockApi({});
  setup();
  expect(screen.getByText("MCP 서버 조회 권한이 없습니다.")).toBeVisible();
  expect(api.calls).toHaveLength(0);
});

it("keeps loading distinct from disabled/empty metadata and waits for a stored match before flow", async () => {
  let resolve: (value: typeof list) => void = () => undefined;
  const api = mockApi({
    "GET /admin/mcp/upstreams": () =>
      new Promise<typeof list>((done) => {
        resolve = done;
      }),
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
  });
  setup();
  const detail = screen.getByRole("dialog");
  expect(within(detail).getByText("MCP 서버 정보를 불러오고 있습니다.")).toBeVisible();
  expect(within(detail).queryByText("상태")).not.toBeInTheDocument();
  expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/mcp/upstreams"]);
  await act(async () => resolve(list));
  expect(await within(detail).findByText("사용")).toBeVisible();
  await waitFor(() => expect(api.calls).toHaveLength(2));
  expect(within(detail).getByRole("button", { name: "연결 진단" })).toBeDisabled();
});

it("shows a missing-server explanation without probing an arbitrary URL ID", async () => {
  const api = mockApi({ "GET /admin/mcp/upstreams": () => ({ upstreams: [], discovery_errors: {} }) });
  setup();
  expect(await screen.findByText("MCP 서버를 찾을 수 없습니다.")).toBeVisible();
  expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/mcp/upstreams"]);
  expect(within(screen.getByRole("dialog")).queryByText("상태")).not.toBeInTheDocument();
});

it("shows errors without a false missing-server or disabled status", async () => {
  mockApi({
    "GET /admin/mcp/upstreams": () => {
      throw apiFailure("fixture unavailable");
    },
  });
  setup();
  const detail = screen.getByRole("dialog");
  expect(await within(detail).findByText("MCP 서버 정보 조회에 실패했습니다.")).toBeVisible();
  expect(within(detail).queryByText("상태")).not.toBeInTheDocument();
  expect(screen.queryByText("MCP 서버를 찾을 수 없습니다.")).not.toBeInTheDocument();
});

it("drops cached metadata immediately on permission loss", async () => {
  mockApi({
    "GET /admin/mcp/upstreams": () => list,
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
  });
  const view = setup();
  expect(await screen.findByRole("dialog", { name: "검색 서버" })).toBeVisible();
  auth.scopes = ["admin:read"];
  view.rerender(view.tree());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("검색 서버")).not.toBeInTheDocument();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
});

it("ignores late metadata from the previous principal", async () => {
  let resolve: (value: typeof list) => void = () => undefined;
  let count = 0;
  mockApi({
    "GET /admin/mcp/upstreams": () =>
      ++count === 1
        ? new Promise<typeof list>((done) => {
            resolve = done;
          })
        : { upstreams: [], discovery_errors: {} },
  });
  const view = setup();
  auth.id = "reader-b";
  view.rerender(view.tree());
  await act(async () => resolve(list));
  expect(await screen.findByText("MCP 서버를 찾을 수 없습니다.")).toBeVisible();
  expect(screen.queryByText("검색 서버")).not.toBeInTheDocument();
});

it("hides retained metadata after a permission-denied refetch", async () => {
  let denied = false;
  mockApi({
    "GET /admin/mcp/upstreams": () => {
      if (denied) throw apiFailure("denied", 403);
      return list;
    },
    "GET /admin/mcp/upstreams/search-server/flow": () => emptyFlow,
  });
  const view = setup();
  expect(await screen.findByRole("dialog", { name: "검색 서버" })).toBeVisible();
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["mcp", "upstreams"] });
  });
  expect(screen.queryByRole("dialog", { name: "검색 서버" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("dialog")).queryByText("엔드포인트")).not.toBeInTheDocument();
});
