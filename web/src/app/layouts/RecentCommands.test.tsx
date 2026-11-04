import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import { usePreferences } from "@/shared/stores/preferences";
import { CommandPalette } from "./CommandPalette";
import { rememberCommand } from "./recent-commands";

const identity = vi.hoisted(() => ({ id: "public-a", team: "public-team", scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: identity.scopes, user: { id: identity.id, team_id: identity.team } }),
  };
});

function Harness({ shortcuts = true }: { shortcuts?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        팔레트 열기
      </button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        onShowShortcuts={shortcuts ? () => undefined : undefined}
      />
    </>
  );
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (shortcuts = true) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness shortcuts={shortcuts} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  const user = userEvent.setup();
  const open = async () => user.click(screen.getByRole("button", { name: "팔레트 열기" }));
  const execute = async (query: string) => {
    await open();
    await user.type(screen.getByRole("combobox", { name: "메뉴 검색" }), query);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  };
  return { ...view, user, open, execute, update: (shortcuts = true) => view.rerender(tree(shortcuts)) };
}
beforeEach(() => {
  identity.id = "public-a";
  identity.team = "public-team";
  identity.scopes = ["admin:read"];
  tokenStore.clearAll();
  usePreferences.setState({ theme: "system", density: "default", recentFeatures: [] });
});

describe("최근 콘솔 명령", () => {
  it("허용 목록의 명령 ID만 중복 없이 최근 다섯 개로 제한한다", () => {
    let history: string[] = [];
    for (const name of ["refresh", "theme", "density", "refresh-interval", "sidebar", "shortcuts"])
      history = rememberCommand(history, `action:${name}`);
    expect(history).toHaveLength(5);
    expect(history).not.toContain("action:refresh");
    expect(rememberCommand(history, "action:theme")[0]).toBe("action:theme");
    expect(rememberCommand(history, "action:theme")).toHaveLength(5);
    for (const input of ["검색 원문", "jump:request_id", "feature:overview", "/app/secret", "action:delete"])
      expect(rememberCommand(history, input)).toEqual(history);
  });
  it("최근 순서·중복 제거·현재 설정 힌트와 키보드 재실행을 제공한다", async () => {
    const c = setup();
    await c.execute("테마");
    await c.execute("밀도");
    await c.execute("테마");
    await c.open();
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAccessibleName(/테마 전환.*밝게.*최근 명령/u);
    expect(options[1]).toHaveAccessibleName(/밀도 전환.*최근 명령/u);
    expect(screen.getAllByRole("option", { name: /테마 전환/u })).toHaveLength(1);
    await c.user.keyboard("{Enter}");
    expect(usePreferences.getState().theme).toBe("system");
    expect(screen.getByRole("button", { name: "팔레트 열기" })).toHaveFocus();
    expect(JSON.stringify(localStorage)).not.toContain("action:theme");
    expect(JSON.stringify(sessionStorage)).not.toContain("action:theme");
  });
  it("기록 지우기는 설정을 바꾸지 않고 검색창으로 초점을 복원한다", async () => {
    const c = setup();
    await c.execute("테마");
    await c.open();
    await c.user.click(screen.getByRole("button", { name: "최근 명령 지우기" }));
    expect(screen.queryByText("최근 명령")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(usePreferences.getState().theme).toBe("dark");
  });
  it.each(["id", "team", "scopes"] as const)(
    "%s 전환과 원래 값 복귀 모두 기록을 되살리지 않는다",
    async (field) => {
      const c = setup();
      await c.execute("테마");
      await c.open();
      const before = { ...identity };
      if (field === "scopes") identity.scopes = ["routing:read"];
      else identity[field] = "public-b";
      c.update();
      expect(screen.queryByText("최근 명령")).not.toBeInTheDocument();
      Object.assign(identity, before);
      c.update();
      expect(screen.queryByText("최근 명령")).not.toBeInTheDocument();
    },
  );
  it("세션 변경과 새 마운트에서 검색 입력과 명령 기록을 제거한다", async () => {
    const c = setup();
    await c.execute("테마");
    await c.open();
    await c.user.type(screen.getByRole("combobox"), "남기지 않는 검색어");
    act(() => tokenStore.clearAll());
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByText("최근 명령")).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain("남기지 않는 검색어");
    c.unmount();
    const next = setup();
    await next.open();
    expect(screen.queryByText("최근 명령")).not.toBeInTheDocument();
  });
  it("더 이상 제공하지 않는 명령을 기록에서 실행할 수 없다", async () => {
    const c = setup();
    await c.execute("단축키");
    c.update(false);
    await c.open();
    expect(within(screen.getByRole("listbox")).queryByText("최근 명령")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /단축키 도움말/u })).not.toBeInTheDocument();
  });
});
