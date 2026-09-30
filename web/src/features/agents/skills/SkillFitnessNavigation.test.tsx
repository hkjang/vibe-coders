import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { SkillPage } from "./SkillPage";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { mockApi } from "@/test/api";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
const first = { name: "first", description: "첫 스킬" },
  second = { name: "second", description: "다른 스킬" };
async function setup() {
  const api = mockApi({
    "GET /admin/skills": () => ({ skills: [first, second] }),
    "GET /admin/skills/stats": () => ({ stats: [], window_since: "2026-01-01T00:00:00Z" }),
    "GET /admin/skills/fitness": ({ query }) => ({
      skill: (query as { skill: string }).skill,
      evidence: [],
      passing_count: 0,
      required: 2,
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider blockNavigation>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "/agents/skills", element: <SkillPage /> },
          {
            path: "/away",
            element: (
              <main id="main-content" tabIndex={-1}>
                다른 화면
              </main>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/away", "/agents/skills"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const other = await screen.findByRole("button", { name: "second 상세 열기" });
  await user.click(screen.getByRole("button", { name: "first 상세 열기" }));
  await user.click(await screen.findByRole("button", { name: "적합성 근거" }));
  const trigger = await screen.findByRole("button", { name: "근거 기록" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" });
  await user.type(within(dialog).getByRole("textbox", { name: "참조 ID" }), "남길 참조");
  return { api, router, user, dialog, other };
}
describe("실제 스킬 화면의 초안 이동 경계", () => {
  it.each(["route", "back"])("%s 이동은 결정 전까지 초안을 보존하고 unload를 보호한다", async (kind) => {
    const { router, user, dialog, api } = await setup();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const navigate = () => {
      if (kind === "back") void router.navigate(-1);
      else void router.navigate("/away");
    };
    act(navigate);
    await user.click(await screen.findByRole("button", { name: "계속 편집" }));
    expect(router.state.location.pathname).toBe("/agents/skills");
    expect(within(dialog).getByRole("textbox", { name: "참조 ID" })).toHaveValue("남길 참조");
    act(navigate);
    await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    if (kind === "route") expect(await screen.findByText("다른 화면")).toBeVisible();
    expect(api.bodies("POST /admin/skills/fitness")).toEqual([]);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
  it("다른 행의 선택도 폐기 뒤에만 대상 URL을 바꾸고 새 초안은 빈 상태다", async () => {
    const { router, user, dialog, other, api } = await setup();
    // Invoke the parent React handler boundary, not a user click through the inert dialog.
    fireEvent.click(other);
    await user.click(await screen.findByRole("button", { name: "계속 편집" }));
    expect(router.state.location.search).toContain("skill=first");
    expect(within(dialog).getByText("대상 스킬: first")).toBeVisible();
    fireEvent.click(other);
    await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(router.state.location.search).toContain("skill=second");
    const sheet = await screen.findByRole("dialog", { name: "second" });
    const opener = await within(sheet).findByRole("button", { name: "근거 기록" });
    await waitFor(() => expect(opener).toBeEnabled());
    await user.click(opener);
    const newer = await screen.findByRole("dialog", { name: "스킬 적합성 근거 기록" });
    expect(within(newer).getByRole("textbox", { name: "참조 ID" })).toHaveValue("");
    expect(within(newer).getByText("대상 스킬: second")).toBeVisible();
    expect(api.bodies("POST /admin/skills/fitness")).toEqual([]);
  });
});
