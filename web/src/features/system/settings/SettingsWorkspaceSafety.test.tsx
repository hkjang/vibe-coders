import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { AppError } from "@/shared/api/error";
import { downloadText } from "@/shared/utils/csv";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
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
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
function setup(overrides: Record<string, ApiHandler> = {}, route = "/system/settings?tab=runtime") {
  const state = { settings: [setting] as EffectiveSetting[], readOnly: false };
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
async function open() {
  await userEvent.click(await screen.findByRole("button", { name: "cache.chat_enabled 설정 열기" }));
  return screen.findByRole("combobox", { name: "새 값" });
}
beforeEach(() => {
  Object.assign(identity, { id: "a", team: "team-a", role: "admin", scopes: ["admin:read", "admin:write"] });
});

describe("설정 작업 공간 권한과 수명", () => {
  it.each(["ops_admin", "ai_admin", "security_admin"])(
    "%s는 서버가 허용한 설정을 admin:write 없이 저장한다",
    async (role) => {
      identity.role = role;
      identity.scopes = ["admin:read"];
      const { api } = setup();
      await userEvent.selectOptions(await open(), "false");
      await userEvent.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(api.bodies(update)).toEqual([{ value: "false", expected_version: 3 }]));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "ClickHouse 연결 테스트" })).toBeDisabled();
    },
  );
  it.each(["viewer", "admin", "ops_admin"])(
    "%s는 범주 또는 쓰기 권한이 없으면 저장할 수 없다",
    async (role) => {
      identity.role = role;
      identity.scopes = ["admin:read"];
      const { api } = setup({
        [effective]: () => ({ settings: [{ ...setting, can_write: role !== "ops_admin" }] }),
      });
      await open();
      expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
      expect(api.bodies(update)).toHaveLength(0);
    },
  );
  it("조회 전용 전환은 초안을 보존하고 쓰기와 연결 테스트를 잠근다", async () => {
    const { state, refresh, api } = setup();
    await userEvent.selectOptions(await open(), "false");
    state.readOnly = true;
    refresh();
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ClickHouse 연결 테스트", hidden: true })).toBeDisabled();
    state.readOnly = false;
    refresh();
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(api.bodies(update)).toHaveLength(0);
  });
  it("서버가 변경 권한을 회수하면 기존 값과 버전 초안은 그대로 두고 저장을 잠근다", async () => {
    const { state, client } = setup();
    await userEvent.selectOptions(await open(), "false");
    state.settings = [{ ...setting, version: 4, can_write: false }];
    await act(() => client.invalidateQueries({ queryKey: systemSettingsKeys.effective }));
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });
  it.each(["account", "team", "role"])("%s 변경 시 초안과 이전 조회 캐시를 버린다", async (kind) => {
    const { state, client, refresh } = setup();
    await userEvent.selectOptions(await open(), "false");
    const old = client
      .getQueryCache()
      .findAll({ queryKey: systemSettingsKeys.effective })
      .map((query) => query.queryHash);
    if (kind === "account") identity.id = "b";
    if (kind === "team") identity.team = "team-b";
    if (kind === "role") identity.role = "super_admin";
    state.settings = [{ ...setting, value: "true", description: "새 계정 설정" }];
    refresh();
    expect(await screen.findByRole("combobox", { name: "새 값" })).toHaveValue("true");
    expect(old.every((hash) => client.getQueryCache().get(hash) === undefined)).toBe(true);
  });
  it("이전 계정의 늦은 조회와 이력 응답을 다음 계정에 표시하지 않는다", async () => {
    const pending = deferred<{ history: unknown[] }>();
    const read = deferred<{ settings: EffectiveSetting[] }>();
    const { refresh, client } = setup({
      [effective]: () => (identity.id === "a" ? { settings: [setting] } : read.promise),
      "GET /admin/settings/history": () => (identity.id === "a" ? pending.promise : { history: [] }),
    });
    await open();
    identity.id = "b";
    refresh();
    expect(screen.queryByRole("combobox", { name: "새 값" })).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve({ history: [{ id: "old", changed_by: "이전 계정 전용 이력" }] });
      read.resolve({ settings: [{ ...setting, value: "false" }] });
    });
    expect(await screen.findByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(screen.queryByText("이전 계정 전용 이력")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("이전 계정 전용 이력");
  });
  it.each([401, 403])("최종 %s 조회 거부는 초안과 캐시를 지우고 명시적 재조회만 허용한다", async (status) => {
    let denied = false;
    const { client } = setup({
      [effective]: () => {
        if (denied) throw apiFailure("거부", status);
        return { settings: [setting] };
      },
    });
    await userEvent.selectOptions(await open(), "false");
    denied = true;
    await act(() => client.invalidateQueries({ queryKey: systemSettingsKeys.effective }));
    expect(await screen.findByText("설정 조회 권한 확인 필요")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.getQueryCache().findAll({ queryKey: systemSettingsKeys.effective })).toHaveLength(0);
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    expect(await screen.findByRole("combobox", { name: "새 값" })).toHaveValue("true");
  });
  it("이전 계정의 늦은 저장 완료는 새 계정의 초안을 닫거나 성공 알림을 만들지 않는다", async () => {
    const pending = deferred<EffectiveSetting>();
    const { refresh } = setup({ [update]: () => pending.promise });
    await userEvent.selectOptions(await open(), "false");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    identity.id = "b";
    refresh();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "새 값" }), "false");
    await act(async () => pending.resolve(setting));
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("읽기 전용을 거친 진행 중 저장은 권한 복구 후에도 과거 성공 알림을 표시하지 않는다", async () => {
    const pending = deferred<EffectiveSetting>();
    const { state, refresh } = setup({ [update]: () => pending.promise });
    await userEvent.selectOptions(await open(), "false");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    state.readOnly = true;
    refresh();
    state.readOnly = false;
    refresh();
    await act(async () => pending.resolve(setting));
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("false");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("계정 전환은 이전 계정의 반영 대기 요청 ID도 캐시에서 제거한다", async () => {
    const { refresh, client } = setup({
      [update]: () => {
        throw new AppError("saved", {
          kind: "http",
          status: 503,
          code: "setting_reload_pending",
          requestId: "previous-principal-outcome",
        });
      },
    });
    await userEvent.selectOptions(await open(), "false");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("요청 ID: previous-principal-outcome")).toBeVisible();
    identity.id = "b";
    refresh();
    await screen.findByRole("button", { name: "cache.chat_enabled 설정 열기" });
    expect(screen.queryByText("요청 ID: previous-principal-outcome")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("previous-principal-outcome");
  });

  it("계정 전환 후 완료된 백업 응답은 파일로 내려받지 않는다", async () => {
    const pending = deferred<object>();
    const { refresh, api } = setup({ "GET /admin/settings/export": () => pending.promise });
    await screen.findByRole("button", { name: "cache.chat_enabled 설정 열기" });
    await userEvent.click(screen.getByRole("button", { name: /백업/ }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "GET /admin/settings/export")).toBe(true),
    );
    identity.id = "b";
    refresh();
    await act(async () => pending.resolve({ settings: [] }));
    expect(downloadText).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("런타임 설정 상세 주소", () => {
  it("목록 검색과 범주에 가려진 설정도 주소로 직접 열고 복원한다", async () => {
    setup({}, "/system/settings?tab=runtime&q=없음&category=logging&setting=cache.chat_enabled");
    expect(await screen.findByRole("dialog", { name: "cache.chat_enabled" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "새 값" })).toHaveValue("true");
  });
  it("키 링크가 검색·범주를 보존하고 닫기·뒤로·앞으로 이동 시 선택을 복원한다", async () => {
    setup({}, "/system/settings?tab=runtime&q=cache&category=cache");
    await userEvent.click(await screen.findByRole("link", { name: "cache.chat_enabled" }));
    expect(await screen.findByRole("dialog", { name: "cache.chat_enabled" })).toBeVisible();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent(
      "q=cache&category=cache&setting=cache.chat_enabled",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent(
      "/system/settings?tab=runtime&q=cache&category=cache",
    );
    await userEvent.click(screen.getByRole("link", { name: "cache.chat_enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "뒤로", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("q=cache&category=cache");
    await userEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(await screen.findByRole("dialog", { name: "cache.chat_enabled" })).toBeVisible();
  });
  it.each([
    ["unknown.setting", "설정을 찾을 수 없습니다."],
    ["INVALID/key", "설정 주소를 확인하세요."],
    ["ui.app.enabled", "설정을 찾을 수 없습니다."],
  ])("%s를 값 변경 없이 설명한다", async (key, message) => {
    const { api } = setup({}, `/system/settings?tab=runtime&setting=${encodeURIComponent(key ?? "")}`);
    expect(await screen.findByText(message ?? "")).toBeVisible();
    expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });
});
