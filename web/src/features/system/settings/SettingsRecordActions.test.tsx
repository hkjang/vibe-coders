import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi, apiFailure, type ApiHandler } from "@/test/api";
import { TrackingTab } from "./TrackingTab";
import { SystemErrorsTab } from "./SystemErrorsTab";

const identity = vi.hoisted(() => ({ id: "a", team: "a", read: true, write: true, readonly: false }));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: identity.id, team_id: identity.team },
        scopes: identity.read ? ["admin:read", ...(identity.write ? ["admin:write"] : [])] : [],
      }),
  };
});
const origin = "https://collector.example.invalid";
const tracking = {
  enabled: true,
  active: true,
  provider: "custom",
  allowed_hosts: ["https://existing.example.invalid"],
  violations: [
    {
      origin,
      directive: "connect-src",
      page: "/app",
      count: 3,
      allowed: false,
      last_seen: "2026-11-18T00:00:00Z",
    },
  ],
};
const errors = {
  errors: [
    { id: "1", component: "retention", error_message: "공개 예제 오류", created_at: "2026-11-18T00:00:00Z" },
  ],
};
function setup(tab: "tracking" | "errors", extra: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/tracking/violations": () => tracking,
    "POST /admin/tracking/violations/allow": () => tracking,
    "DELETE /admin/tracking/violations": () => ({ ...tracking, violations: [] }),
    "GET /admin/system-errors": () => errors,
    "POST /admin/system-errors/clear": () => ({ status: "cleared" }),
    ...extra,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider
          value={{ featureId: "system.settings", permitted: true, readOnly: identity.readonly }}
        >
          {tab === "tracking" ? (
            <TrackingTab hasAdminWrite={identity.write} />
          ) : (
            <SystemErrorsTab hasAdminWrite={identity.write} />
          )}
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, client, refresh: () => view.rerender(tree()) };
}
beforeEach(() => {
  Object.assign(identity, { id: "a", team: "a", read: true, write: true, readonly: false });
  vi.clearAllMocks();
});

it("출처 허용은 영향과 변경 전후를 확인하기 전에는 전송하지 않는다", async () => {
  const c = setup("tracking");
  await userEvent.click(await screen.findByRole("button", { name: `${origin} 허용` }));
  expect(c.api.bodies("POST /admin/tracking/violations/allow")).toHaveLength(0);
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/script-src/u)).toBeVisible();
  expect(dialog.getByText("변경 전")).toBeVisible();
  expect(dialog.getByText("변경 후")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "취소" }));
  const trigger = screen.getByRole("button", { name: `${origin} 허용` });
  await waitFor(() => expect(trigger).toHaveFocus());
  await userEvent.click(trigger);
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "출처 허용" }));
  await waitFor(() => expect(c.api.bodies("POST /admin/tracking/violations/allow")).toEqual([{ origin }]));
});

it.each(["tracking", "errors"] as const)(
  "%s 읽기 전용 전환은 열린 삭제 확인창의 전송도 차단한다",
  async (tab) => {
    const c = setup(tab);
    const label = tab === "tracking" ? "기록 비우기" : "전체 비우기";
    const trigger = await screen.findByRole("button", { name: label });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    identity.readonly = true;
    c.refresh();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: tab === "tracking" ? "비우기" : label })).toBeDisabled();
    expect(c.api.calls.every((c) => c.key.startsWith("GET "))).toBe(true);
  },
);

const cases = [
  {
    tab: "tracking" as const,
    trigger: `${origin} 허용`,
    confirm: "출처 허용",
    path: "POST /admin/tracking/violations/allow",
  },
  {
    tab: "tracking" as const,
    trigger: "기록 비우기",
    confirm: "비우기",
    path: "DELETE /admin/tracking/violations",
  },
  {
    tab: "errors" as const,
    trigger: "전체 비우기",
    confirm: "전체 비우기",
    path: "POST /admin/system-errors/clear",
  },
];
it.each(cases)(
  "$path 불확실한 결과는 재전송하지 않고 새 조회와 확인을 요구한다",
  async ({ tab, trigger, confirm, path }) => {
    const c = setup(tab, {
      [path]: () => {
        throw apiFailure("uncertain", 503);
      },
    });
    const button = await screen.findByRole("button", { name: trigger });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.dblClick(dialog.getByRole("button", { name: confirm }));
    await dialog.findByRole("alert");
    expect(c.api.bodies(path)).toHaveLength(1);
    expect(dialog.getByRole("button", { name: confirm })).toBeDisabled();
    const options = c.api.spy.mock.calls.find(
      ([endpoint]) => `${endpoint.method} ${endpoint.path}` === path,
    )?.[1];
    expect(options?.retryUnauthorized).toBe(false);
    await userEvent.click(dialog.getByRole("button", { name: "취소" }));
    expect(button).toBeDisabled();
    await act(async () => {
      await c.client.invalidateQueries();
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(c.api.bodies(path)).toHaveLength(1);
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
    await waitFor(() => expect(c.api.bodies(path)).toHaveLength(2));
  },
);
it.each(cases)(
  "$path 확인 중 다시 조회한 결과는 새 검토가 필요하다",
  async ({ tab, trigger, confirm, path }) => {
    const c = setup(tab);
    const button = await screen.findByRole("button", { name: trigger });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await act(async () => {
      await c.client.invalidateQueries();
    });
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: confirm })).toBeDisabled(),
    );
    expect(c.api.bodies(path)).toHaveLength(0);
  },
);
for (const tab of ["tracking", "errors"] as const) {
  const path = tab === "tracking" ? "GET /admin/tracking/violations" : "GET /admin/system-errors";
  const content = tab === "tracking" ? origin : "공개 예제 오류";
  const result = tab === "tracking" ? tracking : errors;
  it.each([401, 403])(`${tab} 서버 %s 이후 이전 기록을 폐기하고 명시적으로 다시 조회한다`, async (code) => {
    let denied = false;
    const c = setup(tab, {
      [path]: () => {
        if (denied) throw apiFailure("denied", code);
        return result;
      },
    });
    await screen.findByText(content);
    denied = true;
    await act(async () => {
      await c.client.invalidateQueries();
    });
    expect(await screen.findByText("기록 조회 권한 확인 필요")).toBeVisible();
    expect(screen.queryByText(content)).not.toBeInTheDocument();
    const reads = c.api.bodies(path).length;
    await act(async () => {
      await c.client.invalidateQueries();
    });
    expect(c.api.bodies(path)).toHaveLength(reads);
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    expect(await screen.findByText(content)).toBeVisible();
  });
  it(`${tab} 첫 조회 실패를 기록 없음으로 표시하지 않는다`, async () => {
    setup(tab, {
      [path]: () => {
        throw apiFailure("unavailable", 503);
      },
    });
    await screen.findByRole("alert");
    expect(
      screen.queryByText(tab === "tracking" ? "차단된 출처가 없습니다." : "기록된 시스템 오류가 없습니다."),
    ).not.toBeInTheDocument();
  });
  it(`${tab} 계정 변경 시 이전 조회와 확인을 폐기한다`, async () => {
    let resolve!: (value: typeof result) => void;
    let reads = 0;
    const c = setup(tab, {
      [path]: () =>
        ++reads === 1
          ? result
          : new Promise<typeof result>((done) => {
              resolve = done;
            }),
    });
    await screen.findByText(content);
    identity.id = "b";
    c.refresh();
    expect(screen.queryByText(content)).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    c.unmount();
    await act(async () => resolve(result));
    expect(notices.success).not.toHaveBeenCalled();
    expect(c.client.getQueryCache().getAll()).toHaveLength(0);
  });
}
it.each(cases)(
  "$path 화면을 떠난 뒤 결과가 도착해도 후속 알림과 새 화면 조회를 실행하지 않는다",
  async ({ tab, trigger, confirm, path }) => {
    let resolve!: (value: unknown) => void;
    const c = setup(tab, {
      [path]: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const button = await screen.findByRole("button", { name: trigger });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
    await waitFor(() => expect(c.api.bodies(path)).toHaveLength(1));
    const calls = c.api.calls.length;
    c.unmount();
    await act(async () => resolve(tab === "tracking" ? tracking : { status: "cleared" }));
    expect(c.api.calls).toHaveLength(calls);
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).not.toHaveBeenCalled();
  },
);
