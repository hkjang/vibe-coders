import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import * as downloads from "@/shared/utils/csv";
import * as exporter from "./model-csv";
import { ModelExportControl } from "./ModelExportControl";
import { ModelReadBoundary } from "./ModelReadBoundary";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  scopes: ["admin:read"],
  prefixes: ["vc_sk_"],
  permitted: true,
  readonly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: runtime.prefixes,
    }),
  };
});
const snapshot: Awaited<ReturnType<typeof exporter.loadModelExport>> = {
  catalogue: {
    generated_at: "2026-10-14T00:00:00Z",
    request_id: "public-export",
    partial_failures: [],
    providers: [],
    models: [
      {
        id: "public-model",
        provider: "public-provider",
        provider_ref: "prv_" + "a".repeat(43),
        source: "live",
        stale: false,
        virtual: false,
        shadowed: false,
        shadowed_by: "",
        object: "model",
        owned_by: "public",
        created: null,
        fetched_at: "2026-10-14T00:00:00Z",
        deprecation: null,
      },
    ],
  },
  quality: { models: [], categories: [], since: "2026-10-14T00:00:00Z" },
  pricing: { effective: {}, versions: [] },
  tags: { tags: [] },
};
function deferred() {
  let resolve!: (value: typeof snapshot) => void;
  const promise = new Promise<typeof snapshot>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let filters: exporter.ModelExportFilters = { query: "", provider: "", status: "all", range: "24h" };
  let blocked = false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <FeatureAccessContext.Provider
        value={{
          featureId: "gateway.models",
          permitted: runtime.permitted,
          readOnly: runtime.readonly,
          status: runtime.readonly ? "preview_read_only" : "preview",
        }}
      >
        <ModelReadBoundary>
          <ModelExportControl filters={filters} blocked={blocked} />
        </ModelReadBoundary>
      </FeatureAccessContext.Provider>
    </QueryClientProvider>
  );
  const read = vi.spyOn(exporter, "loadModelExport").mockResolvedValue(snapshot);
  const download = vi.spyOn(downloads, "downloadCsv").mockImplementation(() => undefined);
  const view = render(tree());
  return {
    ...view,
    client,
    read,
    download,
    user: userEvent.setup(),
    button: () => screen.getByRole("button", { name: "CSV 내보내기" }),
    update: (next?: Partial<exporter.ModelExportFilters>, deny = false) => {
      filters = { ...filters, ...next };
      blocked = deny;
      view.rerender(tree());
    },
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    scopes: ["admin:read"],
    prefixes: ["vc_sk_"],
    permitted: true,
    readonly: false,
  });
  tokenStore.clearAll();
});

it("읽기 전용 내보내기는 중복 클릭을 합치고 키보드 포커스를 보존한다", async () => {
  runtime.readonly = true;
  const c = setup();
  const pending = deferred();
  c.read.mockReturnValue(pending.promise);
  const button = c.button();
  button.focus();
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(c.read).toHaveBeenCalledTimes(1);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(async () => pending.resolve(snapshot));
  expect(c.download).toHaveBeenCalledTimes(1);
  expect(c.download.mock.calls[0]?.[0]).toBe("모델-목록.csv");
  expect(button).toHaveFocus();
  expect(button).not.toHaveAttribute("aria-disabled");
  expect(screen.getByRole("status")).toHaveTextContent("1개 모델");
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
});
it.each(["id", "team", "scopes", "prefixes", "permitted", "filter", "session", "unmount"] as const)(
  "%s 변경 후 늦은 응답은 다운로드하지 않는다",
  async (kind) => {
    const c = setup();
    const pending = deferred();
    c.read.mockReturnValue(pending.promise);
    await c.user.click(c.button());
    const signal = c.read.mock.calls[0]?.[1];
    if (kind === "session") act(() => tokenStore.clearAll());
    else if (kind === "unmount") c.unmount();
    else if (kind === "filter") c.update({ query: "new-filter" });
    else {
      if (kind === "id" || kind === "team") runtime[kind] = "public-b";
      if (kind === "scopes") runtime.scopes = [];
      if (kind === "prefixes") runtime.prefixes = ["corp_"];
      if (kind === "permitted") runtime.permitted = false;
      c.update();
      if (kind === "id") {
        runtime.id = "public-a";
        c.update();
      }
    }
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot));
    expect(c.download).not.toHaveBeenCalled();
  },
);
it("권한과 유효한 필터가 없으면 조회하지 않는다", async () => {
  runtime.scopes = [];
  const c = setup();
  expect(screen.queryByRole("button", { name: "CSV 내보내기" })).not.toBeInTheDocument();
  runtime.scopes = ["admin:read"];
  c.update(undefined, true);
  expect(c.button()).toBeDisabled();
  await c.user.click(c.button());
  expect(c.read).not.toHaveBeenCalled();
});
it("일시 실패는 원문 없이 안내하고 자동 재시도 없이 수동으로 복구한다", async () => {
  const c = setup();
  c.read.mockRejectedValueOnce(
    new AppError("private-body-never-show", {
      kind: "http",
      status: 503,
      requestId: "public-export-request",
    }),
  );
  await c.user.click(c.button());
  expect(await screen.findByRole("alert")).toHaveTextContent("public-export-request");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private-body");
  expect(c.read).toHaveBeenCalledTimes(1);
  expect(c.download).not.toHaveBeenCalled();
  await c.user.click(c.button());
  await waitFor(() => expect(c.download).toHaveBeenCalledTimes(1));
});
it.each([401, 403])("내보내기 %s도 모델 조회 경계를 닫고 명시적으로 재확인한다", async (status) => {
  const c = setup();
  c.read.mockRejectedValueOnce(
    new AppError("private-denial", { kind: status === 401 ? "auth" : "permission", status }),
  );
  await c.user.click(c.button());
  expect(await screen.findByRole("heading", { name: "모델 조회 권한 확인 필요" })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  expect(c.download).not.toHaveBeenCalled();
  await c.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
  await c.user.click(c.button());
  await waitFor(() => expect(c.download).toHaveBeenCalledTimes(1));
});
it("빈 부분 응답은 파일 없이 누락 가능성을 안내한다", async () => {
  const c = setup();
  c.read.mockResolvedValue({
    ...snapshot,
    catalogue: {
      ...snapshot.catalogue,
      models: [],
      partial_failures: [
        {
          code: "public-failure",
          message: "public",
          provider: "public",
          provider_ref: "prv_" + "a".repeat(43),
        },
      ],
    },
  });
  await c.user.click(c.button());
  expect(await screen.findByRole("status")).toHaveTextContent("파일을 만들지 않았습니다");
  expect(screen.getByRole("status")).toHaveTextContent("일부 목록이 누락");
  expect(c.download).not.toHaveBeenCalled();
});
