import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { resourceSearchPath } from "./resource-search-items";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { resourceSearchSchema } from "@/shared/api/resource-search";
const runtime = vi.hoisted(() => ({ version: "v0.86.102", hidden: false, scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: runtime.version,
    legacyFallback: true,
    credentialPrefixes: ["corp_"],
    user: {
      id: "reader",
      role: "admin",
      roles: ["admin"],
      team_id: "alpha",
      scopes: runtime.scopes,
    },
    features: migrationRegistry
      .filter((f) => ["gateway.models", "agents.workflows"].includes(f.featureId))
      .map((f) => (runtime.hidden && f.featureId === "gateway.models" ? { ...f, status: "hidden" } : f)),
  }),
}));
const alpha = `prv_${"a".repeat(43)}`,
  beta = `prv_${"b".repeat(43)}`;
const item = {
  kind: "model",
  id: "정산 모델",
  title: "정산 모델",
  provider_ref: alpha,
  provider_label: "공급자 가",
};
function response(status = "ok") {
  return {
    request_id: "model-search",
    groups: [
      {
        kind: "model",
        status,
        limited: false,
        items: [item, { ...item, provider_ref: beta, provider_label: "공급자 나" }],
      },
    ],
  };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const go = vi.fn();
  const tree = () => (
    <QueryClientProvider client={client}>
      <ResourceSearchPanel go={go} />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, go, client };
}
beforeEach(() => {
  runtime.version = "v0.86.102";
  runtime.hidden = false;
  runtime.scopes = ["admin:read"];
});
it("같은 이름의 모델을 공급자별로 구분하고 캐시 출처를 고정하지 않는다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response());
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(await screen.findAllByRole("option")).toHaveLength(2);
  expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { query: "정산", kinds: ["model", "workflow"] } });
  expect(screen.getByRole("option", { name: /공급자 나/ })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  const path = new URL(view.go.mock.calls[0]?.[0] as string, "https://console.invalid");
  expect(path.pathname).toBe("/gateway/models");
  expect(path.searchParams.get("model")).toBe("정산 모델");
  expect(path.searchParams.get("model_provider")).toBe(beta);
  expect(path.searchParams.has("source")).toBe(false);
  view.unmount();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
});
it("일부 목록만 확인되어도 안전한 모델을 열고 재시도할 수 있다", async () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response("partial"));
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  expect(await screen.findAllByRole("option")).toHaveLength(2);
  expect(screen.getByRole("status")).toHaveTextContent("모델 (일부 목록만 확인됨)");
  request.mockResolvedValue(response());
  fireEvent.click(screen.getByRole("button", { name: "자원 검색 다시 시도" }));
  await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("일부 목록만 확인됨"));
  expect(screen.getByRole("combobox")).toHaveFocus();
});
it("이전 서버에는 모델 종류를 보내지 않는다", async () => {
  runtime.version = "v0.86.101";
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(response());
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { kinds: ["workflow"] } });
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
it("권한이나 기능이 바뀌면 이전 모델 결과를 즉시 제거한다", async () => {
  vi.spyOn(apiClient, "request").mockResolvedValue(response());
  const view = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await screen.findAllByRole("option");
  runtime.hidden = true;
  view.rerender(view.tree());
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveValue("");
});
it("모델 공급자 식별자와 민감정보를 검증한다", async () => {
  const value = response();
  value.groups = [
    {
      kind: "model",
      status: "ok",
      limited: false,
      items: [
        { ...item, provider_ref: "raw-provider" },
        { ...item, provider_label: "corp_" + "x".repeat(43) },
      ],
    },
  ];
  vi.spyOn(apiClient, "request").mockResolvedValue(value);
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0개의 자원"));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(resourceSearchPath("model", "line\nfeed", [], undefined, alpha)).toBeUndefined();
  expect(resourceSearchPath("model", "model", [])).toBeUndefined();
});
it("검색 실패 그룹은 잘못 포함된 모델 결과도 표시하지 않는다", async () => {
  vi.spyOn(apiClient, "request").mockResolvedValue(response("unavailable"));
  setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
  await screen.findByRole("button", { name: "자원 검색 다시 시도" });
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
it("실제 응답 계약은 부분 결과와 불투명 공급자 참조를 검증한다", () => {
  expect(resourceSearchSchema.safeParse(response("partial")).success).toBe(true);
  const bad = response();
  bad.groups = [{ kind: "model", status: "ok", limited: false, items: [{ ...item, provider_ref: "raw" }] }];
  expect(resourceSearchSchema.safeParse(bad).success).toBe(false);
});
