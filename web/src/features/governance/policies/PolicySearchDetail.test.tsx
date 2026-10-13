import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { PolicySearchDetail } from "./PolicySearchDetail";

const runtime = vi.hoisted(() => ({ id: "reader-a", scopes: ["security:read"], permitted: true }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    credentialPrefixes: ["vc_sk_", "corp_"],
    user: { id: runtime.id, role: "admin", roles: ["admin"], team_id: "team-a", scopes: runtime.scopes },
  }),
}));
const response = {
  policies: [
    {
      id: "policy-one",
      name: "정산 정책",
      enabled: true,
      priority: 100,
      rollout_percent: 25,
      description: "private-description",
      rules: [{ id: "rule-one", actions: { note: "private-action" } }],
    },
  ],
};
function Location() {
  return <output aria-label="현재 주소">{useLocation().search}</output>;
}
function setup(url = "/governance/policies?policy=policy-one&tab=safety") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <FeatureAccessContext.Provider
          value={{ featureId: "governance.policies", permitted: runtime.permitted, readOnly: true }}
        >
          <main id="main-content" tabIndex={-1}>
            <Location />
            <PolicySearchDetail />
          </main>
        </FeatureAccessContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { ...render(tree()), tree, client };
}

describe("read-only policy search detail", () => {
  it("keeps retry focus and blocks repeated requests while a read is pending", async () => {
    let resolve: (value: typeof response) => void = () => undefined;
    const request = vi
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    setup();
    await screen.findByRole("heading", { name: "정산 정책" });
    const retry = screen.getByRole("button", { name: "정책 다시 조회" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "true"));
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "정산 정책" })).not.toBeInTheDocument();
    await act(async () => resolve(response));
    expect(await screen.findByRole("heading", { name: "정산 정책" })).toBeVisible();
  });
  beforeEach(() => {
    runtime.id = "reader-a";
    runtime.scopes = ["security:read"];
    runtime.permitted = true;
  });

  it("opens the exact URL-selected policy without exposing definitions or permitting writes", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    setup();
    expect(await screen.findByRole("heading", { name: "정산 정책" })).toBeVisible();
    expect(screen.getByText("25%")).toBeVisible();
    expect(screen.getByText("1개")).toBeVisible();
    expect(screen.queryByText("private-description")).not.toBeInTheDocument();
    expect(screen.queryByText("private-action")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].method).toBe("GET");
    fireEvent.click(screen.getByRole("button", { name: "패널 닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("?tab=safety");
    await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
  });

  it.each([
    "/governance/policies",
    "/governance/policies?policy=",
    "/governance/policies?policy=corp_" + "x".repeat(43),
  ])("does not fetch for an absent or invalid selection", (url) => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    setup(url);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["scope", "feature"])("removes detail immediately after %s access is lost", async (boundary) => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response);
    const view = setup();
    await screen.findByRole("heading", { name: "정산 정책" });
    if (boundary === "scope") runtime.scopes = ["admin:read"];
    else runtime.permitted = false;
    view.rerender(view.tree());
    expect(screen.queryByRole("heading", { name: "정산 정책" })).not.toBeInTheDocument();
    expect(screen.getByText("정책 조회 권한이 없습니다.")).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["principal", "session"])(
    "does not reuse previous %s data or a late response",
    async (boundary) => {
      let resolve: (value: typeof response) => void = () => undefined;
      const request = vi
        .spyOn(apiClient, "request")
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue({ policies: [] });
      const view = setup();
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      if (boundary === "principal") {
        runtime.id = "reader-b";
        view.rerender(view.tree());
      } else act(() => tokenStore.clearAll());
      await screen.findByText("정책을 찾을 수 없습니다.");
      await act(async () => resolve(response));
      expect(screen.queryByRole("heading", { name: "정산 정책" })).not.toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each([401, 403, 503])("clears old data on %s, keeps retry focus and recovers", async (status) => {
    const request = vi
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(
        new AppError("private-server-message", { kind: "http", status, requestId: "policy-error-id" }),
      )
      .mockResolvedValue(response);
    setup();
    await screen.findByRole("heading", { name: "정산 정책" });
    const retry = screen.getByRole("button", { name: "정책 다시 조회" });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "정산 정책" })).not.toBeInTheDocument();
    expect(screen.queryByText("private-server-message")).not.toBeInTheDocument();
    expect(screen.getByText("요청 ID: policy-error-id")).toBeVisible();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "정산 정책" })).toBeVisible();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("masks a name that has become sensitive since metadata search", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      policies: [{ ...response.policies[0], name: "corp_" + "x".repeat(43) }],
    });
    setup();
    expect(
      await screen.findByRole("heading", { name: "민감정보가 포함될 수 있어 표시하지 않습니다." }),
    ).toBeVisible();
  });
});
