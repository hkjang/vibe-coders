import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { RequestSavedFilters } from "./RequestSavedFilters";

const runtime = vi.hoisted(() => ({
  id: "admin-a",
  mode: "authenticated" as "authenticated" | "legacy" | "open",
  team: "team-a",
  scopes: ["admin:read", "admin:write"],
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: runtime.mode,
    credentialPrefixes: ["corp_"],
    user: { id: runtime.id, team_id: runtime.team, role: "admin", roles: ["admin"], scopes: runtime.scopes },
  }),
}));
const filter = {
  id: "filt_1",
  name: "서버 오류",
  view: "requests",
  params: "status=5xx&limit=25&tz=UTC",
  created_by: "another-admin",
  created_at: "2026-11-16T00:00:00Z",
};

function mount(query: AppRequestsQuery = { model: "before", limit: 50, tz: "UTC", cursor: "page-token" }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const apply = vi.fn();
  const tree = (value: AppRequestsQuery) => (
    <QueryClientProvider client={client}>
      <FeatureAccessContext.Provider
        value={{
          featureId: "observability.requests",
          permitted: true,
          readOnly: runtime.readOnly,
          status: "preview",
        }}
      >
        <RequestSavedFilters query={value} onApply={apply} />
      </FeatureAccessContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree(query));
  return { ...view, client, apply, refresh: (value = query) => view.rerender(tree(value)) };
}
const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "공유 필터" }));
  await screen.findByRole("combobox", { name: "저장된 공유 필터" });
  await user.selectOptions(screen.getByRole("combobox"), "filt_1");
  return user;
};

describe("request shared filters", () => {
  beforeEach(() => {
    runtime.id = "admin-a";
    runtime.mode = "authenticated";
    runtime.team = "team-a";
    runtime.scopes = ["admin:read", "admin:write"];
    runtime.readOnly = false;
    vi.spyOn(apiClient, "request").mockResolvedValue({ filters: [filter] } as never);
  });
  it("loads only on demand, previews before applying, and keeps filtering separate from selecting", async () => {
    const view = mount();
    expect(apiClient.request).not.toHaveBeenCalled();
    const user = await open();
    expect(view.apply).not.toHaveBeenCalled();
    expect(screen.getByText("서버 오류 (5xx)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "이 조건으로 조회" }));
    const params = view.apply.mock.calls[0]?.[0] as URLSearchParams;
    expect(params.get("status")).toBe("5xx");
    expect(params.has("cursor")).toBe(false);
    expect(apiClient.request).toHaveBeenCalledTimes(1);
  });
  it("saves the reviewed applied snapshot despite later query changes and restores keyboard focus", async () => {
    const view = mount();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "현재 조건 저장" });
    await user.click(trigger);
    await user.type(screen.getByRole("textbox", { name: "필터 이름" }), "  운영 모델  ");
    view.refresh({ model: "after", limit: 200 });
    await user.click(screen.getByRole("button", { name: "공유 필터 저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const call = vi.mocked(apiClient.request).mock.calls.find(([endpoint]) => endpoint.method === "POST");
    expect(call?.[1]).toMatchObject({
      body: { name: "운영 모델", view: "requests", params: "tz=UTC&model=before&limit=50" },
    });
    expect(trigger).toHaveFocus();
  });
  it("renames another administrator's shared filter without overwriting criteria", async () => {
    mount();
    const user = await open();
    await user.click(screen.getByRole("button", { name: "이름 변경" }));
    const input = screen.getByRole("textbox", { name: "필터 이름" });
    await user.clear(input);
    await user.type(input, "운영 장애");
    await user.click(screen.getAllByRole("button", { name: "이름 변경" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const call = vi.mocked(apiClient.request).mock.calls.find(([endpoint]) => endpoint.method === "PATCH");
    expect(call?.[0].path).toBe("/admin/saved-filters/filt_1");
    expect(call?.[1]).toMatchObject({ body: { name: "운영 장애" } });
  });
  it("confirms shared deletion and sends it once while pending", async () => {
    let finish: ((value: never) => void) | undefined;
    vi.mocked(apiClient.request).mockImplementation((endpoint) =>
      endpoint.method === "DELETE"
        ? new Promise<never>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ filters: [filter] } as never),
    );
    mount();
    const user = await open();
    await user.click(screen.getByRole("button", { name: "삭제" }));
    expect(screen.getByText(/모든 관리자의 공유 목록에서 삭제/)).toBeVisible();
    const submit = screen.getByRole("button", { name: "공유 필터 삭제" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        vi.mocked(apiClient.request).mock.calls.filter(([endpoint]) => endpoint.method === "DELETE"),
      ).toHaveLength(1),
    );
    await act(async () => {
      finish?.({ id: filter.id, status: "deleted" } as never);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it.each(["scope", "runtime"])(
    "allows read-only apply but blocks writes under %s restriction",
    async (restriction) => {
      if (restriction === "scope") runtime.scopes = ["admin:read"];
      else runtime.readOnly = true;
      const view = mount();
      const user = await open();
      expect(screen.getByRole("button", { name: "현재 조건 저장" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "이름 변경" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "삭제" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "이 조건으로 조회" }));
      expect(view.apply).toHaveBeenCalledOnce();
    },
  );
  it.each(["legacy", "open"] as const)("honors effective readonly scopes in %s mode", async (mode) => {
    runtime.mode = mode;
    runtime.scopes = ["admin:read"];
    const view = mount();
    const user = await open();
    expect(screen.getByRole("button", { name: "현재 조건 저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "이름 변경" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "이 조건으로 조회" }));
    expect(view.apply).toHaveBeenCalledOnce();
  });
  it("keeps the draft during a write-only restriction and refuses submission", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "현재 조건 저장" }));
    await user.type(screen.getByRole("textbox", { name: "필터 이름" }), "작성 중");
    runtime.readOnly = true;
    view.refresh();
    expect(screen.getByRole("textbox", { name: "필터 이름" })).toHaveValue("작성 중");
    expect(screen.getByRole("button", { name: "공유 필터 저장" })).toBeDisabled();
    runtime.readOnly = false;
    view.refresh();
    expect(screen.getByRole("textbox", { name: "필터 이름" })).toHaveValue("작성 중");
    expect(apiClient.request).not.toHaveBeenCalled();
  });
  it("rejects secret names locally and gives a focused inline error", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "현재 조건 저장" }));
    const input = screen.getByRole("textbox", { name: "필터 이름" });
    await user.type(input, `corp_${"q".repeat(35)}`);
    await user.click(screen.getByRole("button", { name: "공유 필터 저장" }));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(apiClient.request).not.toHaveBeenCalled();
  });
  it("shows incompatible conditions without applying or rendering their contents", async () => {
    vi.mocked(apiClient.request).mockResolvedValue({
      filters: [{ ...filter, params: "prompt=hidden-content" }],
    } as never);
    const view = mount();
    await open();
    expect(screen.getByText(/지원하지 않거나 중복된 조건/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "이 조건으로 조회" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("hidden-content");
    expect(view.apply).not.toHaveBeenCalled();
  });
  it("clears data and drafts on principal change, suppressing late mutation success", async () => {
    const success = vi.spyOn(toast, "success");
    let finish: ((value: never) => void) | undefined;
    vi.mocked(apiClient.request).mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "현재 조건 저장" }));
    await user.type(screen.getByRole("textbox", { name: "필터 이름" }), "이전 관리자");
    await user.click(screen.getByRole("button", { name: "공유 필터 저장" }));
    runtime.id = "admin-b";
    view.refresh();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      finish?.({ filter } as never);
    });
    expect(success).not.toHaveBeenCalled();
    expect(view.client.getQueryCache().findAll()).toHaveLength(1);
  });
  it("retires denied reads and retries in a new lifetime without retaining shared names", async () => {
    vi.mocked(apiClient.request).mockRejectedValueOnce(
      new AppError("denied", { status: 403, kind: "permission" }),
    );
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공유 필터" }));
    const retry = await screen.findByRole("button", { name: "공유 필터 권한 다시 확인" });
    await user.click(retry);
    await open();
    expect(screen.getByText("서버 오류 (5xx)")).toBeVisible();
  });
  it("removes pending reads on logout", async () => {
    let finish: ((value: never) => void) | undefined;
    vi.mocked(apiClient.request).mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공유 필터" }));
    await act(async () => {
      tokenStore.clearTokens();
    });
    await act(async () => {
      finish?.({ filters: [filter] } as never);
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .findAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
});
