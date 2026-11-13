import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";

const runtime = vi.hoisted(() => ({
  version: "v0.86.99",
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
      .filter((f) => f.featureId === "system.settings")
      .map((f) => (runtime.hidden ? { ...f, status: "hidden" } : f)),
  }),
}));
const response = {
  request_id: "setting-search",
  groups: [
    {
      kind: "setting",
      status: "ok",
      limited: false,
      items: [
        { kind: "setting", id: "cache.chat_enabled", title: "채팅 캐시 사용 여부" },
        { kind: "setting", id: "ui.app.enabled", title: "신규 콘솔 사용 여부" },
        {
          kind: "setting",
          id: "ui.app.feature.system.settings.rollout",
          title: "시스템 설정 점진 배포 비율",
        },
      ],
    },
  ],
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
  Object.assign(runtime, { version: "v0.86.99", hidden: false, team: "alpha", scopes: ["admin:read"] }),
);

it("설정 키와 한글 설명 결과를 구분하고 런타임·콘솔 상세로 연결한다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  const view = setup(),
    input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "설정" } });
  expect(await screen.findAllByRole("option")).toHaveLength(3);
  expect(screen.getByText("시스템 설정 · cache.chat_enabled")).toBeVisible();
  expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { query: "설정", kinds: ["setting"] } });
  for (let i = 0; i < 3; i++) {
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
  }
  const paths = view.go.mock.calls.map(([path]) => new URL(path as string, "https://console.invalid"));
  expect(paths.map((path) => path.pathname)).toEqual(Array(3).fill("/system/settings"));
  expect(paths.map((path) => Object.fromEntries(path.searchParams))).toEqual([
    { setting: "cache.chat_enabled", tab: "runtime" },
    { setting: "ui.app.enabled", tab: "console" },
    { setting: "ui.app.feature.system.settings.rollout", tab: "console" },
  ]);
});
it.each(["old", "hidden", "write-only"])("%s 상태에서는 설정 검색을 실행하지 않는다", (mode) => {
  if (mode === "old") runtime.version = "v0.86.98";
  if (mode === "hidden") runtime.hidden = true;
  if (mode === "write-only") runtime.scopes = ["admin:write"];
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "설정" } });
  expect(screen.getByText("검색할 수 있는 자원 권한이 없습니다.")).toBeVisible();
  expect(request).not.toHaveBeenCalled();
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

it("등록 키 형식이 아니거나 민감정보인 식별자를 주소로 만들지 않는다", () => {
  for (const id of [
    " leading",
    "line\nfeed",
    "../cache",
    "cache?value=secret",
    "cache/child",
    "a".repeat(257),
    "corp_" + "x".repeat(43),
  ])
    expect(resourceSearchPath("setting", id, ["corp_"])).toBeUndefined();
});
