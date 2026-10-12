import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResourceSearchPanel from "./ResourceSearchPanel";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { resourceSearchPath } from "./resource-search-items";

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
  });
});
