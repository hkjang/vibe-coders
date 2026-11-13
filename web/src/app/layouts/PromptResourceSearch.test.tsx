import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({
  version: "v0.86.97",
  hidden: false,
  team: "alpha",
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
      .filter((f) => ["prompts.library", "prompts.lab"].includes(f.featureId))
      .map((f) => (runtime.hidden && f.featureId === "prompts.library" ? { ...f, status: "hidden" } : f)),
  }),
}));
const response = {
  request_id: "prompt-search",
  groups: ["prompt_asset", "prompt_experiment"].map((kind) => ({
    kind,
    status: "ok",
    limited: false,
    items: [{ kind, id: "정산/a&b", title: "정산 요약" }],
  })),
};
function setup() {
  const go = vi.fn(),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ResourceSearchPanel go={go} />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, go, client };
}
beforeEach(() =>
  Object.assign(runtime, { version: "v0.86.97", hidden: false, team: "alpha", scopes: ["admin:read"] }),
);

it("이름이 같은 자산과 실험을 구분하고 읽기 권한으로 정확한 상세 주소를 연다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup(),
    input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "정산" } });
  expect(await screen.findAllByRole("option")).toHaveLength(2);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { query: "정산", kinds: ["prompt_asset", "prompt_experiment"] },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  const asset = new URL(view.go.mock.calls[0]?.[0] as string, "https://console.invalid");
  const exp = new URL(view.go.mock.calls[1]?.[0] as string, "https://console.invalid");
  expect(asset.pathname).toBe("/prompts/library");
  expect(Object.fromEntries(asset.searchParams)).toEqual({ asset: "정산/a&b", tab: "assets" });
  expect(exp.pathname).toBe("/prompts/lab");
  expect(Object.fromEntries(exp.searchParams)).toEqual({ exp: "정산/a&b" });
});

it.each(["old", "hidden", "write-only"])("%s 상태의 검색 결과를 이동에 사용하지 않는다", async (mode) => {
  if (mode === "old") runtime.version = "v0.86.96";
  if (mode === "hidden") runtime.hidden = true;
  if (mode === "write-only") runtime.scopes = ["admin:write"];
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  if (mode === "hidden") {
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { kinds: ["prompt_experiment"] } });
  } else {
    expect(screen.getByText("검색할 수 있는 자원 권한이 없습니다.")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  }
});

it("계정 범위가 바뀐 뒤 도착한 결과를 폐기한다", async () => {
  let release!: (data: typeof response) => void;
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
});

it("상세 화면에서 사용할 수 없는 식별자를 주소로 변환하지 않는다", () => {
  for (const kind of ["prompt_asset", "prompt_experiment"] as const)
    for (const id of [" leading", "line\nfeed", "😀".repeat(257), "corp_" + "x".repeat(43)])
      expect(resourceSearchPath(kind, id, ["corp_"])).toBeUndefined();
});
