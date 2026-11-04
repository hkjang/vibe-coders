import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { ModelPage } from "./ModelPage";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { usePreferences } from "@/shared/stores/preferences";
import { AppError } from "@/shared/api/error";
import { contractFixture, deprecationFixture, runFixture } from "./model-governance-test-fixtures";
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

const listing = { contracts: [contractFixture] };

async function setup(
  write: () => Promise<unknown> = async () => ({}),
  run: () => Promise<unknown> = async () => runFixture,
) {
  let reader: () => typeof listing | Promise<typeof listing> = () => listing;
  let denied: string | undefined;
  const read = <T,>(path: string, value: T): T => {
    if (path === denied) throw new AppError("public-denied", { kind: "permission", status: 403 });
    return value;
  };
  const api = mockApi({
    "GET /admin/models": () => read("catalog", { models: [], providers: [], partial_failures: [] }),
    "GET /admin/models/quality": () => read("quality", { models: [], categories: [] }),
    "GET /admin/pricing": () => read("pricing", { effective: {}, versions: [] }),
    "GET /admin/model-tags": () => read("tags", { tags: [] }),
    "GET /admin/model-deprecations": () => read("deprecations", { deprecations: [deprecationFixture] }),
    "GET /admin/models/contracts": () => reader(),
    "POST /admin/models/contracts": write,
    "POST /admin/models/contracts/run": run,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider
          value={{ featureId: "gateway.models", permitted: true, readOnly: runtime.readonly }}
        >
          <ModelPage />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "모델 계약" }));
  return {
    ...view,
    api,
    client,
    user,
    deny: (path: string) => {
      denied = path;
    },
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

it.each(["catalog", "quality", "pricing", "tags", "deprecations"])(
  "%s 조회 거부도 전체 모델 화면의 이전 데이터를 폐기한다",
  async (endpoint) => {
    const c = await setup();
    await screen.findByText(contractFixture.name);
    if (endpoint === "deprecations") {
      await c.user.click(screen.getByRole("tab", { name: "지원 종료" }));
      await screen.findByRole("table", { name: "모델 지원 종료 정책" });
    }
    c.deny(endpoint);
    await act(async () => {
      await c.client.refetchQueries();
    });
    expect(await screen.findByRole("heading", { name: "모델 조회 권한 확인 필요" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  },
);

it.each(["id", "team", "role", "prefixes", "epoch"] as const)(
  "%s 전환에서 이전 모델 계약 캐시를 새 조회 완료 전 노출하지 않는다",
  async (boundary) => {
    const c = await setup();
    await screen.findByText(contractFixture.name);
    c.block();
    if (boundary === "epoch") act(() => tokenStore.clearAll());
    else if (boundary === "prefixes") {
      runtime.prefixes = ["corp_"];
      c.update();
    } else {
      runtime[boundary] = "public-b";
      c.update();
    }
    expect(screen.queryByText(contractFixture.name)).not.toBeInTheDocument();
    await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
    await waitFor(() =>
      expect(c.api.calls.filter((call) => call.key === "GET /admin/models/contracts")).toHaveLength(2),
    );
  },
);

it("쓰기 권한만 회수되면 초안을 보존하지만 조회 권한 회수 시 원문을 숨긴다", async () => {
  const c = await setup();
  await screen.findByText(contractFixture.name);
  await c.user.click(screen.getByRole("button", { name: "계약 추가" }));
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
  expect(screen.queryByText(contractFixture.name)).not.toBeInTheDocument();
});

it("A → B → A의 이전 응답을 폐기하고 현재 A를 새로 조회한다", async () => {
  const c = await setup();
  await screen.findByText(contractFixture.name);
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
  await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
  await waitFor(() =>
    expect(c.api.calls.filter((call) => call.key === "GET /admin/models/contracts")).toHaveLength(2),
  );
  c.read(
    () =>
      new Promise((resolve) => {
        replyA = resolve;
      }),
  );
  runtime.id = "public-a";
  c.update();
  await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
  await waitFor(() =>
    expect(c.api.calls.filter((call) => call.key === "GET /admin/models/contracts")).toHaveLength(3),
  );
  await act(async () => {
    replyB(listing);
  });
  expect(screen.queryByText(contractFixture.name)).not.toBeInTheDocument();
  await act(async () => {
    replyA({ contracts: listing.contracts.map((row) => ({ ...row, name: "공개 새 조회" })) });
  });
  await screen.findByText("공개 새 조회");
  expect(
    JSON.stringify(
      c.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain(contractFixture.name);
});

it.each([401, 403])("서버 %s는 이전 표시·캐시를 폐기하고 수동 확인으로만 복구한다", async (status) => {
  const c = await setup();
  await screen.findByText(contractFixture.name);
  c.read(async () => {
    throw new AppError("never-display-server-detail", {
      kind: status === 401 ? "auth" : "permission",
      status,
    });
  });
  await act(async () => {
    await c.client.refetchQueries({ queryKey: ["gateway", "models", "contracts"] });
  });
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveFocus();
  expect(screen.queryByText(contractFixture.name)).not.toBeInTheDocument();
  expect(screen.queryByText("never-display-server-detail")).not.toBeInTheDocument();
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  const calls = c.api.calls.length;
  c.read(() => listing);
  c.update();
  expect(c.api.calls).toHaveLength(calls);
  await c.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
  await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
  await screen.findByText(contractFixture.name);
});

async function editAndSave(c: Awaited<ReturnType<typeof setup>>, name: string) {
  await c.user.click(screen.getByRole("button", { name: "수정" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByRole("textbox", { name: /^이름/u });
  await c.user.clear(input);
  await c.user.type(input, name);
  await c.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await within(dialog).findByRole("table", { name: "모델 계약 변경 전후 비교" });
  await c.user.click(within(dialog).getByRole("button", { name: "검토한 계약 저장" }));
}

it.each(["read", "team", "role"] as const)(
  "%s 전환 후 진행 중 저장은 중복하지 않고 이전 결과를 게시하지 않는다",
  async (boundary) => {
    let resolve!: (data: object) => void;
    let writes = 0;
    const c = await setup(() =>
      ++writes === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve({}),
    );
    const success = vi.spyOn(toast, "success");
    const invalidate = vi.spyOn(c.client, "invalidateQueries");
    await screen.findByText(contractFixture.name);
    await editAndSave(c, "public-first");
    await waitFor(() => expect(writes).toBe(1));
    const request = c.api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST");
    expect(request?.[1]).toMatchObject({ retryUnauthorized: false });
    if (boundary === "read") runtime.scopes = [];
    else runtime[boundary] = "public-next";
    c.update();
    expect(screen.queryByDisplayValue("public-first")).not.toBeInTheDocument();
    runtime.scopes = ["admin:read", "admin:write"];
    c.update();
    await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
    await screen.findByText(contractFixture.name);
    await editAndSave(c, "public-second");
    await screen.findByText("모델 변경을 처리 중입니다. 완료 후 다시 확인하세요.");
    expect(writes).toBe(1);
    await act(async () => {
      resolve({});
    });
    expect(success).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("table", { name: "모델 계약 변경 전후 비교" })).toHaveTextContent(
      "public-second",
    );
    await c.user.click(screen.getByRole("button", { name: "검토한 계약 저장" }));
    await waitFor(() => expect(writes).toBe(2));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
  },
);

it.each([
  [false, "account"],
  [true, "account"],
  [false, "tab"],
  [true, "tab"],
] as const)(
  "읽기 전용 계약 검증의 늦은 실패=%s는 새 %s 화면에 표시하지 않는다",
  async (failure, boundary) => {
    runtime.readonly = true;
    let resolve!: (data: unknown) => void;
    let reject!: (error: unknown) => void;
    const c = await setup(
      undefined,
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    await c.user.type(screen.getByRole("textbox", { name: "검증할 모델" }), "public-model");
    await c.user.click(screen.getByRole("button", { name: "계약 검증 실행" }));
    await waitFor(() => expect(c.api.bodies("POST /admin/models/contracts/run")).toHaveLength(1));
    if (boundary === "account") {
      runtime.id = "public-b";
      c.update();
    } else await c.user.click(screen.getByRole("tab", { name: "모델 카탈로그" }));
    await c.user.click(screen.getByRole("tab", { name: "모델 계약" }));
    await act(async () => {
      if (failure) reject(new AppError("public-old-error", { kind: "http", status: 500 }));
      else resolve(runFixture);
    });
    expect(screen.getByRole("textbox", { name: "검증할 모델" })).toHaveValue("");
    expect(screen.queryByText("검증 결과")).not.toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);
