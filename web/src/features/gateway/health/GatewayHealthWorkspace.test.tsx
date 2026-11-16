import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { usePreferences } from "@/shared/stores/preferences";
import { GatewayHealthPage } from "./GatewayHealthPage";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
vi.mock("sonner", () => ({ toast }));
const authFor = (team: string) =>
  testAuth({ scopes: ["admin:read", "routing:read", "routing:write"], user: { team_id: team } });
beforeEach(() => {
  state.auth = authFor("alpha");
  usePreferences.setState({ refreshInterval: 0 });
  toast.success.mockClear();
  toast.error.mockClear();
});
function health(label = "알파 공급자") {
  return {
    since: "2026-11-01T00:00:00Z",
    until: "2026-11-02T00:00:00Z",
    threshold: 70,
    providers: [],
    ranking: [],
    degraded: [],
    alerts: [],
    trend: [],
    breakers: {
      enabled: true,
      threshold: 3,
      cooldown_seconds: 30,
      shared: false,
      instance_id: "fixture",
      states: [
        { provider: label, provider_ref: `prv_${"a".repeat(43)}`, phase: "open", failures: 3, opens: 1 },
      ],
    },
  };
}
function setup(read: ApiHandler = () => health(), write: ApiHandler = () => ({ status: "reset" })) {
  const api = mockApi({
    "GET /health": () => ({ status: "ok" }),
    "GET /ready": () => ({ status: "ready" }),
    "GET /admin/routing/health": read,
    "GET /admin/routing/balancer": () => ({
      mode: "session_hash",
      active_sessions: 2,
      sticky_sessions: true,
      multi_instance_safe: true,
      pools: [],
    }),
    "POST /admin/routing/breaker-reset": write,
    "POST /admin/routing/balancer": write,
  });
  let redraw = () => {};
  let changeRange: (range: string) => void = () => {};
  function Host() {
    const [, update] = useState(0);
    const navigate = useNavigate();
    useLayoutEffect(() => {
      redraw = () => update((x) => x + 1);
      changeRange = (range) => navigate(`/gateway/health?range=${range}`);
    }, [navigate]);
    return (
      <FeatureAccessHarness featureId="gateway.health">
        <GatewayHealthPage />
      </FeatureAccessHarness>
    );
  }
  const view = renderScreen(<Host />, { route: "/gateway/health" });
  return {
    ...view,
    api,
    refresh: () => act(redraw),
    changeRange: (range: string) => act(() => changeRange(range)),
  };
}

it("같은 계정의 팀 변경은 이전 공급자와 확인창을 폐기하고 새 데이터를 조회한다", async () => {
  const current = setup(() => health(state.auth.user?.team_id === "alpha" ? "알파 공급자" : "베타 공급자"));
  await screen.findByText("알파 공급자");
  await userEvent.click(screen.getByRole("button", { name: "해제" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  state.auth = authFor("beta");
  current.refresh();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await screen.findByText("베타 공급자")).toBeVisible();
  expect(screen.queryByText("알파 공급자")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      current.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("알파 공급자");
});

it("조회 거부는 공급자 데이터와 복구 확인창을 닫고 명시적 권한 확인으로 복구한다", async () => {
  let denied = false;
  const current = setup(() => {
    if (denied) throw apiFailure("denied", 403);
    return health();
  });
  await screen.findByText("알파 공급자");
  await userEvent.click(screen.getByRole("button", { name: "해제" }));
  denied = true;
  await act(async () => {
    await current.client.invalidateQueries({ queryKey: ["admin", "routing", "health"] });
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("알파 공급자")).not.toBeInTheDocument();
  expect(screen.getByText("API 연결 가능")).toBeVisible();
  expect(current.api.bodies("POST /admin/routing/breaker-reset")).toEqual([]);
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "권한 다시 확인" }));
  expect(await screen.findByText("알파 공급자")).toBeVisible();
});

it.each([false, true])(
  "이전 팀 작업의 늦은 결과는 새 확인창과 알림에 반영하지 않는다: failure=%s",
  async (failure) => {
    let settle!: () => void;
    const current = setup(
      () => health(state.auth.user?.team_id === "alpha" ? "알파 공급자" : "베타 공급자"),
      () =>
        new Promise((resolve, reject) => {
          settle = () => (failure ? reject(apiFailure("old result")) : resolve({ status: "reset" }));
        }),
    );
    await screen.findByText("알파 공급자");
    await userEvent.click(screen.getByRole("button", { name: "해제" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "해제" }));
    await waitFor(() => expect(current.api.bodies("POST /admin/routing/breaker-reset")).toHaveLength(1));
    state.auth = authFor("beta");
    current.refresh();
    await screen.findByText("베타 공급자");
    await userEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    const next = screen.getByRole("dialog");
    await act(async () => settle());
    expect(next).toBeVisible();
    expect(within(next).queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  },
);

it("팀 변경 전 시작한 조회의 늦은 응답은 새 화면과 캐시에 남지 않는다", async () => {
  let finish!: (data: ReturnType<typeof health>) => void;
  const current = setup(() =>
    state.auth.user?.team_id === "alpha"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : health("베타 공급자"),
  );
  await waitFor(() => expect(finish).toBeDefined());
  state.auth = authFor("beta");
  current.refresh();
  await screen.findByText("베타 공급자");
  await act(async () => finish(health("이전 비공개 공급자")));
  expect(document.body.textContent).not.toContain("이전 비공개 공급자");
  expect(
    JSON.stringify(
      current.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("이전 비공개 공급자");
});

it("일시 조회 오류는 이전 상태를 보여주되 복구 작업은 최신 조회 성공 뒤에 허용한다", async () => {
  let failed = false;
  setup(() => {
    if (failed) throw apiFailure("temporary", 503);
    return health();
  });
  await screen.findByText("알파 공급자");
  failed = true;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(await screen.findByText("새 갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
  expect(screen.getByText("알파 공급자")).toBeVisible();
  expect(screen.getByRole("button", { name: "해제" })).toBeDisabled();
  failed = false;
  await userEvent.click(screen.getByRole("button", { name: "공급자 라우팅 상태 재시도" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "해제" })).toBeEnabled());
});

it("확인 중 상태가 바뀌면 이전 확인으로 전송하지 않는다", async () => {
  let failures = 3;
  const current = setup(() => {
    const result = health();
    const breaker = result.breakers.states[0];
    if (!breaker) throw new Error("missing breaker fixture");
    breaker.failures = failures;
    return result;
  });
  await screen.findByText("알파 공급자");
  await userEvent.click(screen.getByRole("button", { name: "해제" }));
  failures = 7;
  await act(async () => {
    await current.client.invalidateQueries({ queryKey: ["admin", "routing", "health"] });
  });
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "해제" })).toBeDisabled());
  expect(within(dialog).getByText(/최신 상태를 확인한 뒤/)).toBeVisible();
  expect(current.api.bodies("POST /admin/routing/breaker-reset")).toEqual([]);
});

it("기간이 바뀌면 같은 상태 응답이어도 이전 확인으로 복구하지 않는다", async () => {
  const sameSnapshot = health();
  const current = setup(() => sameSnapshot);
  await screen.findByText("알파 공급자");
  await userEvent.click(screen.getByRole("button", { name: "해제" }));
  current.changeRange("7d");
  await waitFor(() =>
    expect(current.api.calls.filter((call) => call.key === "GET /admin/routing/health")).toHaveLength(2),
  );
  await waitFor(() => expect(current.client.isFetching()).toBe(0));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "해제" })).toBeDisabled();
  expect(within(dialog).getByText(/최신 상태를 확인한 뒤/)).toBeVisible();
  expect(current.api.bodies("POST /admin/routing/breaker-reset")).toEqual([]);
});

it("조회 권한이 회수되면 쓰기 권한이 있어도 데이터·확인창과 추가 조회를 차단한다", async () => {
  const current = setup();
  await screen.findByText("알파 공급자");
  await userEvent.click(screen.getByRole("button", { name: "해제" }));
  state.auth = testAuth({ scopes: ["admin:read", "routing:write"], user: { team_id: "alpha" } });
  current.refresh();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("알파 공급자")).not.toBeInTheDocument();
  const calls = current.api.calls.filter((c) => c.key.startsWith("GET /admin/routing/")).length;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(current.api.calls.filter((c) => c.key.startsWith("GET /admin/routing/")).length).toBe(calls);
  expect(current.api.bodies("POST /admin/routing/breaker-reset")).toEqual([]);
});

it("현재 비밀 접두사가 포함된 조회 오류와 요청 ID를 화면에 표시하지 않는다", async () => {
  const secret = "private_health_" + "x".repeat(40);
  state.auth = { ...state.auth, credentialPrefixes: ["private_health_"] };
  setup(() => {
    throw apiFailure(secret, 503, secret);
  });
  await screen.findByRole("button", { name: "공급자 라우팅 상태 재시도" });
  expect(document.body.textContent).not.toContain(secret);
});

it("현재 비밀 접두사를 포함한 공급자 이름은 가리고 개별 복구를 막는다", async () => {
  const secret = "private_health_" + "x".repeat(40);
  state.auth = { ...state.auth, credentialPrefixes: ["private_health_"] };
  setup(() => health(secret));
  await screen.findByText(/공급자 이름 비공개/);
  expect(document.body.textContent).not.toContain(secret);
  expect(screen.getByRole("button", { name: "해제" })).toBeDisabled();
});

it.each(["해제", "세션 고정 전체 해제"])(
  "%s 실패의 비공개 요청 ID는 확인창과 알림에 남기지 않는다",
  async (trigger) => {
    const secret = "private_health_" + "x".repeat(40);
    state.auth = { ...state.auth, credentialPrefixes: ["private_health_"] };
    setup(
      () => health(),
      () => {
        throw apiFailure(secret, 503, secret);
      },
    );
    await screen.findByText("알파 공급자");
    await userEvent.click(screen.getByRole("button", { name: trigger }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "해제" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toContain(secret);
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain(secret);
  },
);
