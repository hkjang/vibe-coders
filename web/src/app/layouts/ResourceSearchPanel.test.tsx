import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { resourceSearchPath } from "./resource-search-items";
import { AppError } from "@/shared/api/error";

const runtime = vi.hoisted(() => ({ id: "admin-a", hidden: false, scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: "v0.86.56",
    legacyFallback: true,
    credentialPrefixes: ["vc_sk_", "corp_"],
    user: { id: runtime.id, role: "admin", roles: ["admin"], team_id: "team-a", scopes: runtime.scopes },
    features: migrationRegistry.map((feature) =>
      runtime.hidden && feature.featureId === "agents.workflows" ? { ...feature, status: "hidden" } : feature,
    ),
  }),
}));

const response = {
  request_id: "safe-request-id",
  groups: [
    {
      kind: "workflow",
      status: "ok",
      limited: false,
      items: [{ kind: "workflow", id: "wf-one", title: "정산 업무" }],
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

describe("permission-scoped resource search", () => {
  beforeEach(() => {
    runtime.id = "admin-a";
    runtime.hidden = false;
    runtime.scopes = ["admin:read"];
  });

  it("does not preload definitions; debounces name metadata search and opens a real detail", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    const { go } = setup();
    expect(request).not.toHaveBeenCalled();
    const input = screen.getByRole("combobox", { name: "자원 이름 검색" });
    fireEvent.change(input, { target: { value: "정산" } });
    expect(request).not.toHaveBeenCalled();
    expect(await screen.findByRole("option", { name: /정산 업무/ })).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.resourceSearch,
      expect.objectContaining({
        body: { query: "정산", kinds: ["provider", "workflow", "app", "skill"] },
        signal: expect.any(AbortSignal),
      }),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(go).toHaveBeenCalledWith("/agents/workflows?workflow=wf-one");
  });

  it("does not send credential-shaped text, even for a custom prefix", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: `corp_${"a".repeat(43)}` } });
    expect(screen.getByRole("status")).toHaveTextContent("전송하지 않습니다");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(request).not.toHaveBeenCalled();
  });

  it("omits forbidden kinds and rejects out-of-scope result groups", async () => {
    runtime.hidden = true;
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.resourceSearch,
      expect.objectContaining({ body: { query: "정산", kinds: ["provider", "app", "skill"] } }),
    );
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("does not query without read permission", () => {
    runtime.scopes = [];
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    expect(screen.getByRole("status")).toHaveTextContent("권한이 없습니다");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires MCP list permission and opens the stored server detail tab", async () => {
    runtime.scopes = ["admin:read", "observability:read"];
    const request = vi.spyOn(apiClient, "request").mockResolvedValue({
      request_id: "safe-request-id",
      groups: [
        {
          kind: "mcp_upstream",
          status: "ok",
          limited: false,
          items: [{ kind: "mcp_upstream", id: "search-server", title: "정산 서버" }],
        },
      ],
    });
    const view = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    expect(await screen.findByRole("option", { name: /정산 서버/ })).toBeVisible();
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.resourceSearch,
      expect.objectContaining({
        body: { query: "정산", kinds: ["provider", "workflow", "app", "skill", "mcp_upstream"] },
      }),
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(view.go).toHaveBeenCalledWith("/mcp?upstream=search-server&tab=upstreams");
    runtime.scopes = ["admin:read", "mcp:admin"];
    view.rerender(view.tree());
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      endpoints.admin.resourceSearch,
      expect.objectContaining({
        body: { query: "정산", kinds: ["provider", "workflow", "app", "skill"] },
      }),
    );
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("retires old responses and clears the draft when the principal changes", async () => {
    let resolve: (value: typeof response) => void = () => undefined;
    const request = vi.spyOn(apiClient, "request").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    runtime.id = "admin-b";
    view.rerender(view.tree());
    resolve(response);
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(1));
  });

  it("cancels outstanding metadata search when the panel closes", async () => {
    let signal: AbortSignal | undefined;
    const request = vi.spyOn(apiClient, "request").mockImplementation((_endpoint, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });
    const view = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    await waitFor(() => expect(request).toHaveBeenCalled());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps good groups while showing partial failure and limited-result guidance", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      groups: [
        { ...response.groups[0], limited: true },
        { kind: "app", status: "unavailable", limited: false, items: [] },
      ],
    });
    setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "정산" } });
    expect(await screen.findByRole("option")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("일부 종류");
    expect(screen.getByRole("status")).toHaveTextContent("더 구체적으로");
    expect(screen.getByRole("button", { name: "자원 검색 다시 시도" })).toBeEnabled();
  });

  it.each([401, 403, 503])(
    "재조회 %i 오류 뒤에는 이전 결과와 요청 ID를 재사용하지 않는다",
    async (status) => {
      const request = vi
        .spyOn(apiClient, "request")
        .mockResolvedValueOnce(response)
        .mockRejectedValueOnce(
          new AppError("비공개 서버 오류", { kind: "http", status, requestId: "failed-request-id" }),
        )
        .mockResolvedValueOnce(response);
      const { client, go } = setup();
      const input = screen.getByRole("combobox");
      fireEvent.change(input, { target: { value: "정산" } });
      await screen.findByRole("option");
      await act(async () => {
        await client.refetchQueries({ queryKey: ["resource-search"] });
      });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("실패했습니다"));
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(screen.getByText("요청 ID: failed-request-id")).toBeVisible();
      expect(screen.queryByText(/safe-request-id/)).not.toBeInTheDocument();
      expect(screen.queryByText("비공개 서버 오류")).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(go).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "자원 검색 다시 시도" }));
      expect(await screen.findByRole("option")).toBeVisible();
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it("재조회 중에는 이전 결과로 이동하지 않고 새 응답만 표시한다", async () => {
    let finish!: (value: typeof response) => void;
    const held = new Promise<typeof response>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(apiClient, "request").mockResolvedValueOnce(response).mockReturnValueOnce(held);
    const { client, go } = setup();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "정산" } });
    await screen.findByRole("option");
    act(() => {
      void client.refetchQueries({ queryKey: ["resource-search"] });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("검색하고 있습니다"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(go).not.toHaveBeenCalled();
    await act(async () => {
      finish({ ...response, groups: [] });
      await held;
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0개의 자원"));
  });

  it("재시도 버튼이 사라져도 검색 입력에 포커스를 유지한다", async () => {
    let finish!: (value: typeof response) => void;
    const held = new Promise<typeof response>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce({
        ...response,
        groups: [...response.groups, { kind: "app", status: "unavailable", limited: false, items: [] }],
      })
      .mockReturnValueOnce(held);
    setup();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "정산" } });
    const retry = await screen.findByRole("button", { name: "자원 검색 다시 시도" });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("검색하고 있습니다"));
    expect(input).toHaveFocus();
    await act(async () => {
      finish(response);
      await held;
    });
    expect(await screen.findByRole("option")).toBeVisible();
    expect(input).toHaveFocus();
  });

  it("does not execute the selected resource during Korean composition", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response);
    const { go } = setup();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "정산" } });
    await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(go).not.toHaveBeenCalled();
  });

  it("constructs only registry destinations with encoded IDs and opaque provider references", () => {
    expect(resourceSearchPath("workflow", "a&b/c", [])).toBe("/agents/workflows?workflow=a%26b%2Fc");
    expect(resourceSearchPath("skill", "스킬", [])).toContain("tab=catalog");
    expect(resourceSearchPath("provider", "raw-provider", [])).toBeUndefined();
    expect(resourceSearchPath("app", `vc_sk_${"x".repeat(43)}`, [])).toBeUndefined();
    expect(resourceSearchPath("mcp_upstream", "search-server", [])).toBe(
      "/mcp?upstream=search-server&tab=upstreams",
    );
    expect(resourceSearchPath("mcp_upstream", "server/path", [])).toBeUndefined();
  });
});
