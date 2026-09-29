import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notificationConfig, roleOptions, ssoConfig } from "@/features/system/settings/inline-settings-test";
import { NotificationForm } from "@/features/system/settings/NotificationForm";
import { SsoConfigForm } from "@/features/system/settings/SsoConfigForm";
import { publishLogout } from "@/shared/auth/token-store";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { mockApi } from "@/test/api";

afterEach(() => vi.restoreAllMocks());

describe.each(["sso", "notifications"] as const)("%s 실제 data-router 경계", (kind) => {
  it.each(["query", "hash", "back"] as const)(
    "%s 이동은 초안 유지/폐기 결정을 거치고 beforeunload와 정리한다",
    async (destination) => {
      const api = mockApi({});
      const user = userEvent.setup();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const router = createMemoryRouter(
        [
          {
            element: (
              <QueryClientProvider client={client}>
                <UnsavedChangesProvider blockNavigation>
                  <main id="main-content" tabIndex={-1}>
                    <Outlet />
                  </main>
                </UnsavedChangesProvider>
              </QueryClientProvider>
            ),
            children: [
              {
                path: "/settings",
                element:
                  kind === "sso" ? (
                    <SsoConfigForm config={ssoConfig} hasAdminWrite roleOptions={roleOptions} />
                  ) : (
                    <NotificationForm config={notificationConfig} hasAdminWrite />
                  ),
              },
              { path: "/previous", element: <p>이전 화면</p> },
            ],
          },
        ],
        { initialEntries: ["/previous", "/settings?tab=original"], initialIndex: 1 },
      );
      const mounted = render(<RouterProvider router={router} />);
      const input = screen.getByLabelText(kind === "sso" ? "클라이언트 비밀키" : "웹훅 주소");
      await user.type(input, "synthetic-draft");
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      const navigate = async () => {
        await act(async () => {
          if (destination === "back") await router.navigate(-1);
          else
            await router.navigate(
              destination === "query" ? "/settings?tab=other" : "/settings?tab=original#section",
            );
        });
      };
      await navigate();
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
      );
      expect(router.state.location.search).toBe("?tab=original");
      expect(input).toHaveValue("synthetic-draft");
      await navigate();
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
      );
      await waitFor(() =>
        expect(
          router.state.location.pathname + router.state.location.search + router.state.location.hash,
        ).toBe(
          destination === "back"
            ? "/previous"
            : destination === "query"
              ? "/settings?tab=other"
              : "/settings?tab=original#section",
        ),
      );
      expect(api.calls).toHaveLength(0);
      const cleanUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(cleanUnload);
      expect(cleanUnload.defaultPrevented).toBe(false);
      mounted.unmount();
      const afterUnmount = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(afterUnmount);
      expect(afterUnmount.defaultPrevented).toBe(false);
      router.dispose();
    },
  );

  it("경로 폐기 확인 중 로그아웃은 초안과 확인을 버리고 이전 탐색을 재개하지 않는다", async () => {
    const api = mockApi({});
    const user = userEvent.setup();
    const client = new QueryClient();
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <QueryClientProvider client={client}>
            <UnsavedChangesProvider blockNavigation>
              {kind === "sso" ? (
                <SsoConfigForm config={ssoConfig} hasAdminWrite roleOptions={roleOptions} />
              ) : (
                <NotificationForm config={notificationConfig} hasAdminWrite />
              )}
            </UnsavedChangesProvider>
          </QueryClientProvider>
        ),
      },
    ]);
    const mounted = render(<RouterProvider router={router} />);
    const input = screen.getByLabelText(kind === "sso" ? "클라이언트 비밀키" : "웹훅 주소");
    await user.type(input, "synthetic-draft");
    await act(async () => {
      await router.navigate("/?next=true");
    });
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    act(() => publishLogout());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(router.state.location.search).toBe("");
    expect(api.calls).toHaveLength(0);
    mounted.unmount();
    router.dispose();
  });
});
