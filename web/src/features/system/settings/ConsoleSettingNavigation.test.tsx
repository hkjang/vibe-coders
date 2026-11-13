import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { mockApi, type ApiHandler } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { SystemSettingsPage } from "./SystemSettingsPage";
import { systemSettingsKeys } from "./use-system-settings";

const identity = vi.hoisted(() => ({
  id: "a",
  team: "team-a",
  role: "admin",
  scopes: ["admin:read", "admin:write"],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: identity.role,
        scopes: identity.scopes,
        user: { id: identity.id, team_id: identity.team },
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/shared/utils/csv", async (original) => ({ ...(await original<object>()), downloadText: vi.fn() }));
const setting: EffectiveSetting = {
  key: "cache.chat_enabled",
  category: "cache",
  description: "채팅 캐시",
  type: "bool",
  value: "true",
  source: "admin",
  version: 3,
  can_write: true,
  permission_group: "ops",
  is_secret: false,
  is_set: true,
  read_only: false,
  restart_required: false,
};
const update = "PUT /admin/settings/by-key/cache.chat_enabled";
const effective = "GET /admin/settings/effective";
function Navigation() {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 주소">{location.pathname + location.search}</output>
      <button onClick={() => void navigate(-1)}>뒤로</button>
      <button onClick={() => void navigate(1)}>앞으로</button>
    </>
  );
}
function setup(overrides: Record<string, ApiHandler> = {}, route = "/system/settings?tab=console") {
  const state = {
    settings: [
      { ...setting, key: "ui.app.enabled", category: "ui.app", description: "신규 콘솔 사용" },
      {
        ...setting,
        key: "ui.app.feature.system.settings.status",
        category: "ui.app.features",
        type: "string",
        value: "preview",
      },
      {
        ...setting,
        key: "ui.app.feature.system.settings.rollout",
        category: "ui.app.features",
        type: "int",
        value: "30",
      },
    ] as EffectiveSetting[],
    readOnly: false,
  };
  const api = mockApi({
    [effective]: () => ({ settings: state.settings }),
    "GET /admin/settings/history": () => ({ history: [] }),
    [update]: () => setting,
    "GET /admin/ui-telemetry/summary": () => ({
      enabled: false,
      days: 7,
      from: "",
      to: "",
      retention_days: 30,
      visit_limit: 100000,
      features: [],
    }),
    ...overrides,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <FeatureAccessHarness featureId="system.settings" readOnly={state.readOnly}>
          <Navigation />
          <SystemSettingsPage />
        </FeatureAccessHarness>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, state, client, refresh: () => view.rerender(tree()) };
}
beforeEach(() => {
  Object.assign(identity, { id: "a", team: "team-a", role: "admin", scopes: ["admin:read", "admin:write"] });
});

it.each([
  "ui.app.enabled",
  "ui.app.feature.system.settings.status",
  "ui.app.feature.system.settings.rollout",
])("%s 직접 주소에서 정확한 편집 화면을 연다", async (key) => {
  setup({}, `/system/settings?tab=console&q=목록밖&setting=${key}`);
  if (key === "ui.app.enabled") {
    expect(await screen.findByRole("dialog", { name: key })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("true");
  } else {
    expect(await screen.findByRole("dialog", { name: "시스템 설정 전환 설정" })).toBeVisible();
    expect(screen.getByText(key, { selector: "code" })).toBeVisible();
    expect(screen.getByLabelText("점진 배포 비율(%)")).toHaveValue(30);
  }
});
it.each(["ui.app.missing", "ui.app.feature.system.settings.roles", "cache.chat_enabled", "../invalid"])(
  "%s는 다른 편집 화면 대신 누락·잘못된 주소를 표시한다",
  async (key) => {
    setup({}, `/system/settings?tab=console&setting=${encodeURIComponent(key)}`);
    expect(await screen.findByRole("dialog", { name: "설정 상세" })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("설정 상세를 불러오는 중입니다.")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
  },
);
it("목록에서 열면 주소를 기록하고 닫기·뒤로·앞으로 이동을 복원한다", async () => {
  setup();
  const button = await screen.findByRole("button", { name: "신규 콘솔 사용 편집" });
  await userEvent.click(button);
  expect(screen.getByLabelText("현재 주소")).toHaveTextContent("setting=ui.app.enabled");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  await userEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "뒤로", hidden: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "앞으로" }));
  expect(await screen.findByRole("dialog", { name: "ui.app.enabled" })).toBeVisible();
});
it("새 응답이 와도 전환 편집의 최초 값·버전과 초안을 보존한다", async () => {
  const bulk = "PUT /admin/settings/bulk";
  const { state, client, api } = setup(
    { [bulk]: () => ({ ok: true }) },
    "/system/settings?tab=console&setting=ui.app.feature.system.settings.rollout",
  );
  const field = await screen.findByLabelText("점진 배포 비율(%)");
  await userEvent.clear(field);
  await userEvent.type(field, "50");
  state.settings = state.settings.map((row) => ({
    ...row,
    version: 9,
    ...(row.key.endsWith(".rollout") ? { value: "70" } : {}),
  }));
  await act(() => client.invalidateQueries({ queryKey: systemSettingsKeys.effective }));
  expect(field).toHaveValue(50);
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(api.bodies(bulk)).toEqual([
      {
        settings: [{ key: "ui.app.feature.system.settings.rollout", value: "50", expected_version: 3 }],
        reason: "",
      },
    ]),
  );
});
it("직접 주소로 연 뒤 조회 전용으로 바뀌면 초안은 유지하고 저장을 차단한다", async () => {
  const { state, refresh } = setup(
    {},
    "/system/settings?tab=console&setting=ui.app.feature.system.settings.rollout",
  );
  const field = await screen.findByLabelText("점진 배포 비율(%)");
  await userEvent.clear(field);
  await userEvent.type(field, "50");
  state.readOnly = true;
  refresh();
  expect(field).toHaveValue(50);
  expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
});
