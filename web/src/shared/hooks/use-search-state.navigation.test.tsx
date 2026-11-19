import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, useBlocker } from "react-router";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppRouterProvider } from "@/app/router/AppRouterProvider";
import { useSearchState, type SearchUpdates } from "./use-search-state";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

function Filters({ first = { console_q: "시스템" } }: { first?: SearchUpdates }) {
  const [params, search] = useSearchState();
  const [, status] = useSearchState();
  return (
    <>
      <output aria-label="검색 조건">{params.toString()}</output>
      <button
        onClick={() => {
          search(first);
          status({ console_status: "preview" });
        }}
      >
        연속 적용
      </button>
      <button onClick={() => status({ console_readonly: "false" })}>쓰기 조건</button>
      <button onClick={() => search({ console_q: null })}>검색 초기화</button>
    </>
  );
}
function setup(options: { first?: SearchUpdates; loader?: () => Promise<null> } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/system/settings",
        element: <Filters first={options.first} />,
        loader: options.loader,
        HydrateFallback: () => <p>불러오는 중</p>,
      },
    ],
    { initialEntries: ["/app/system/settings?tab=console&telemetry_days=7"], basename: "/app" },
  );
  const view = render(<AppRouterProvider router={router} />);
  return { ...view, router };
}

describe("렌더 전 연속 URL 갱신", () => {
  it("서로 다른 필터 훅의 연속 변경이 검색어와 기존 조건을 보존한다", async () => {
    const { router } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "연속 적용" }));
    const params = new URLSearchParams(router.state.location.search);
    expect(Object.fromEntries(params)).toEqual({
      tab: "console",
      telemetry_days: "7",
      console_q: "시스템",
      console_status: "preview",
    });
    expect(screen.getByLabelText("검색 조건")).toHaveTextContent("console_q=");
    fireEvent.click(screen.getByRole("button", { name: "검색 초기화" }));
    expect(new URLSearchParams(router.state.location.search).has("console_q")).toBe(false);
    expect(new URLSearchParams(router.state.location.search).get("console_status")).toBe("preview");
    router.dispose();
  });

  it("로더가 대기하는 동안에도 가장 최근의 대상 조건을 이어서 갱신한다", async () => {
    let release: (() => void) | undefined;
    let held = false;
    const loader = () =>
      held
        ? new Promise<null>((resolve) => {
            release = () => resolve(null);
          })
        : Promise.resolve(null);
    const { router } = setup({ loader });
    const button = await screen.findByRole("button", { name: "연속 적용" });
    held = true;
    fireEvent.click(button);
    expect(new URLSearchParams(router.state.navigation.location?.search).get("console_q")).toBe("시스템");
    fireEvent.click(screen.getByRole("button", { name: "쓰기 조건" }));
    expect(Object.fromEntries(new URLSearchParams(router.state.navigation.location?.search))).toMatchObject({
      console_q: "시스템",
      console_status: "preview",
      console_readonly: "false",
    });
    await act(async () => {
      held = false;
      release?.();
    });
    expect(new URLSearchParams(router.state.location.search).get("console_q")).toBe("시스템");
    router.dispose();
  });

  it("연속 갱신 중에도 자격정보를 URL에 쓰지 않는다", async () => {
    const { router } = setup({ first: { console_q: "vc_sk_do_not_persist_this_test_value" } });
    const recorded: string[] = [];
    const unsubscribe = router.subscribe((state) => recorded.push(state.location.search));
    fireEvent.click(await screen.findByRole("button", { name: "연속 적용" }));
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((search) => !search.includes("vc_sk_"))).toBe(true);
    expect(new URLSearchParams(router.state.location.search).get("console_status")).toBe("preview");
    unsubscribe();
    router.dispose();
  });
  it("뒤로 이동한 뒤 예전 검색어를 다시 끼워 넣지 않는다", async () => {
    const { router } = setup();
    await screen.findByRole("button", { name: "쓰기 조건" });
    await act(async () => {
      await router.navigate("/system/settings?tab=console&console_q=old");
    });
    await act(async () => {
      await router.navigate(-1);
    });
    fireEvent.click(screen.getByRole("button", { name: "쓰기 조건" }));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
      tab: "console",
      telemetry_days: "7",
      console_readonly: "false",
    });
    router.dispose();
  });

  it("다른 화면으로 이동하는 중인 이전 화면의 입력이 이동을 취소하지 않는다", async () => {
    let release: (() => void) | undefined;
    const router = createMemoryRouter(
      [
        { path: "/system/settings", element: <Filters /> },
        {
          path: "/next",
          element: <p>다음 화면</p>,
          loader: () =>
            new Promise<null>((resolve) => {
              release = () => resolve(null);
            }),
        },
      ],
      { initialEntries: ["/app/system/settings?tab=console"], basename: "/app" },
    );
    render(<AppRouterProvider router={router} />);
    await screen.findByRole("button", { name: "쓰기 조건" });
    act(() => {
      void router.navigate("/next");
    });
    fireEvent.click(screen.getByRole("button", { name: "쓰기 조건" }));
    expect(router.state.navigation.location?.pathname).toBe("/app/next");
    await act(async () => {
      release?.();
    });
    expect(await screen.findByText("다음 화면")).toBeVisible();
    expect(router.state.location.search).toBe("");
    router.dispose();
  });

  it("미저장 변경 때문에 취소한 조건은 다음 적용에 섞이지 않는다", async () => {
    function DirtyFilters() {
      const [dirty, setDirty] = useState(true);
      const blocker = useBlocker(dirty);
      const [, update] = useSearchState();
      return (
        <>
          <button onClick={() => update({ console_q: "cancelled" })}>차단 검색</button>
          <button
            onClick={() => {
              blocker.reset?.();
              setDirty(false);
            }}
          >
            이동 취소
          </button>
          <button onClick={() => update({ console_status: "preview" })}>상태 적용</button>
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/system/settings", element: <DirtyFilters /> }], {
      initialEntries: ["/system/settings?tab=console"],
    });
    render(<AppRouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "차단 검색" }));
    expect(router.state.location.search).toBe("?tab=console");
    fireEvent.click(screen.getByRole("button", { name: "이동 취소" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 적용" }));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
      tab: "console",
      console_status: "preview",
    });
    router.dispose();
  });
});
