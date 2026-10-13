import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { ProviderPage } from "./ProviderPage";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { usePreferences } from "@/shared/stores/preferences";
import { AppError } from "@/shared/api/error";
import { toast } from "sonner";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  role: "admin",
  prefixes: ["vc_sk_"],
  scopes: ["admin:read", "admin:write"],
  readonly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({
        role: runtime.role,
        scopes: runtime.scopes,
        user: { id: runtime.id, team_id: runtime.team },
      }),
      credentialPrefixes: runtime.prefixes,
    }),
  };
});

const listing = {
  providers: [
    {
      name: "공개 이전 공급자",
      provider_ref: "prv_" + "x".repeat(43),
      base_url: "https://public.example.invalid/v1",
      api_key_configured: true,
      timeout_ms: 1000,
      enabled: true,
      model_patterns: "public-*",
      failover_group: "public",
      priority: 1,
      created_at: "2026-10-14T00:00:00Z",
    },
  ],
};

function setup(write: () => Promise<unknown> = async () => ({})) {
  let reader: () => typeof listing | Promise<typeof listing> = () => listing;
  const api = mockApi({
    "GET /admin/providers": () => reader(),
    "GET /admin/providers/slo": () => ({ slos: [], evaluations: [], since: "2026-10-14T00:00:00Z" }),
    "POST /admin/providers": write,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider
          value={{ featureId: "gateway.providers", permitted: true, readOnly: runtime.readonly }}
        >
          <ProviderPage />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    api,
    client,
    user: userEvent.setup(),
    update: () => view.rerender(tree()),
    block: () => {
      reader = () => new Promise(() => undefined);
    },
    read: (next: typeof reader) => {
      reader = next;
    },
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    role: "admin",
    prefixes: ["vc_sk_"],
    scopes: ["admin:read", "admin:write"],
    readonly: false,
  });
  tokenStore.clearAll();
  usePreferences.setState({ refreshInterval: 0 });
});

it.each(["id", "team", "role", "prefixes", "epoch"] as const)(
  "%s 전환에서 이전 공급자 캐시를 새 조회 완료 전 노출하지 않는다",
  async (boundary) => {
    const c = setup();
    await screen.findByRole("link", { name: "공개 이전 공급자" });
    c.block();
    if (boundary === "epoch") act(() => tokenStore.clearAll());
    else if (boundary === "prefixes") {
      runtime.prefixes = ["corp_"];
      c.update();
    } else {
      runtime[boundary] = "public-b";
      c.update();
    }
    expect(screen.queryByRole("link", { name: "공개 이전 공급자" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(c.api.calls.filter((call) => call.key === "GET /admin/providers")).toHaveLength(2),
    );
  },
);

it("쓰기 권한만 회수되면 초안을 보존하지만 조회 권한 회수 시 원문을 숨긴다", async () => {
  const c = setup();
  await screen.findByRole("link", { name: "공개 이전 공급자" });
  await c.user.click(screen.getByRole("button", { name: "공급자 추가" }));
  await c.user.type(screen.getByRole("textbox", { name: /^이름/u }), "공개 작성 중 초안");
  runtime.readonly = true;
  c.update();
  expect(screen.getByRole("textbox", { name: /^이름/u })).toHaveValue("공개 작성 중 초안");
  runtime.readonly = false;
  runtime.scopes = ["admin:read"];
  c.update();
  expect(screen.getByRole("textbox", { name: /^이름/u })).toHaveValue("공개 작성 중 초안");
  runtime.scopes = [];
  c.update();
  expect(screen.queryByDisplayValue("공개 작성 중 초안")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "공개 이전 공급자" })).not.toBeInTheDocument();
});

it("A → B → A의 이전 응답을 폐기하고 현재 A를 새로 조회한다", async () => {
  const c = setup();
  await screen.findByRole("link", { name: "공개 이전 공급자" });
  let replyB!: (data: typeof listing) => void;
  let replyA!: (data: typeof listing) => void;
  c.read(
    () =>
      new Promise((resolve) => {
        replyB = resolve;
      }),
  );
  runtime.id = "public-b";
  c.update();
  await waitFor(() =>
    expect(c.api.calls.filter((call) => call.key === "GET /admin/providers")).toHaveLength(2),
  );
  c.read(
    () =>
      new Promise((resolve) => {
        replyA = resolve;
      }),
  );
  runtime.id = "public-a";
  c.update();
  await waitFor(() =>
    expect(c.api.calls.filter((call) => call.key === "GET /admin/providers")).toHaveLength(3),
  );
  await act(async () => {
    replyB(listing);
  });
  expect(screen.queryByRole("link", { name: "공개 이전 공급자" })).not.toBeInTheDocument();
  await act(async () => {
    replyA({ providers: listing.providers.map((row) => ({ ...row, name: "공개 새 조회" })) });
  });
  await screen.findByRole("link", { name: "공개 새 조회" });
  expect(
    JSON.stringify(
      c.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain("공개 이전 공급자");
});

it.each([401, 403])("서버 %s는 이전 표시·캐시를 폐기하고 수동 확인으로만 복구한다", async (status) => {
  const c = setup();
  await screen.findByRole("link", { name: "공개 이전 공급자" });
  c.read(async () => {
    throw new AppError("never-display-server-detail", {
      kind: status === 401 ? "auth" : "permission",
      status,
    });
  });
  await act(async () => {
    await c.client.refetchQueries({ queryKey: ["admin", "providers"] });
  });
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveFocus();
  expect(screen.queryByRole("link", { name: "공개 이전 공급자" })).not.toBeInTheDocument();
  expect(screen.queryByText("never-display-server-detail")).not.toBeInTheDocument();
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  const calls = c.api.calls.length;
  c.read(() => listing);
  c.update();
  expect(c.api.calls).toHaveLength(calls);
  await c.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
  await screen.findByRole("link", { name: "공개 이전 공급자" });
});

async function createDraft(c: ReturnType<typeof setup>, name: string) {
  await c.user.click(screen.getByRole("button", { name: "공급자 추가" }));
  await c.user.type(screen.getByRole("textbox", { name: /^이름/u }), name);
  await c.user.type(screen.getByRole("textbox", { name: /^기본 URL/u }), "https://public.invalid");
  await c.user.click(screen.getByRole("button", { name: "저장" }));
}

it.each(["read", "team", "role"] as const)(
  "%s 전환 뒤에도 기존 저장을 중복 실행하지 않고 늦은 완료를 새 화면에 게시하지 않는다",
  async (boundary) => {
    let resolve!: (data: object) => void;
    let writes = 0;
    const c = setup(() =>
      ++writes === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve({}),
    );
    const success = vi.spyOn(toast, "success");
    const invalidate = vi.spyOn(c.client, "invalidateQueries");
    await screen.findByRole("link", { name: "공개 이전 공급자" });
    await createDraft(c, "public-first");
    await waitFor(() => expect(writes).toBe(1));
    const request = c.api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST");
    expect(request?.[1]).toMatchObject({ retryUnauthorized: false });
    if (boundary === "read") runtime.scopes = [];
    else if (boundary === "team") runtime.team = "public-next-team";
    else runtime.role = "operator";
    c.update();
    expect(screen.queryByDisplayValue("public-first")).not.toBeInTheDocument();
    runtime.scopes = ["admin:read", "admin:write"];
    c.update();
    await screen.findByRole("link", { name: "공개 이전 공급자" });
    await createDraft(c, "public-second");
    await screen.findByText("공급자 변경을 처리 중입니다. 완료 후 다시 확인하세요.");
    expect(writes).toBe(1);
    await act(async () => {
      resolve({});
    });
    expect(success).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /^이름/u })).toHaveValue("public-second");
    await c.user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(writes).toBe(2));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
  },
);
