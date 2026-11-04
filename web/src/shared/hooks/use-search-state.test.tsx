import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchState, type SearchUpdates } from "./use-search-state";

const runtime = vi.hoisted(() => ({ prefixes: ["corp_"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => ({ ...testAuth(), credentialPrefixes: runtime.prefixes }) };
});
function Probe({ updates, replace = true }: { updates: SearchUpdates; replace?: boolean }) {
  const [params, update] = useSearchState();
  return (
    <>
      <output aria-label="현재 검색">{params.toString()}</output>
      <button onClick={() => update(updates, { replace })}>적용</button>
    </>
  );
}
function setup(updates: SearchUpdates, initial = "/app/agents/apps", replace = true) {
  window.history.replaceState(null, "", initial);
  const push = vi.spyOn(window.history, "pushState");
  const swap = vi.spyOn(window.history, "replaceState");
  const result = render(
    <BrowserRouter basename="/app">
      <Probe updates={updates} replace={replace} />
    </BrowserRouter>,
  );
  push.mockClear();
  swap.mockClear();
  return { ...result, push, swap, user: userEvent.setup() };
}
beforeEach(() => {
  runtime.prefixes = ["corp_"];
});
describe("URL 기록 직전 공통 검색 경계", () => {
  it.each([true, false])("replace=%s에서도 사용자 지정 키를 한번도 기록하지 않는다", async (replace) => {
    const secret = `corp_${"A".repeat(32)}`;
    const { user, push, swap } = setup({ q: secret, status: "active" }, undefined, replace);
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(
      [...push.mock.calls, ...swap.mock.calls].every((call) => !String(call[2]).includes("A".repeat(32))),
    ).toBe(true);
    expect(location.search).toBe("?status=active");
    expect(window.history.state.usr).toEqual({ appSensitiveQueryKeys: ["q"] });
  });
  it.each(["corp_", "%41_"])("%s 인코딩 자격정보와 기존 검색값도 재기록하지 않는다", async (prefix) => {
    runtime.prefixes = [prefix];
    const secret = `${prefix}${"B".repeat(32)}`;
    const { user, swap } = setup(
      { status: "active" },
      `/app/agents/apps?q=${encodeURIComponent(encodeURIComponent(secret))}`,
    );
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(swap.mock.calls.every((call) => !String(call[2]).includes("B".repeat(32)))).toBe(true);
    expect(location.search).toBe("?status=active");
  });
  it("새 인증 접두사를 적용한다", async () => {
    const updates = { q: `tenant_${"C".repeat(32)}` };
    const { user, rerender } = setup(updates);
    runtime.prefixes = ["tenant_"];
    act(() =>
      rerender(
        <BrowserRouter basename="/app">
          <Probe updates={updates} />
        </BrowserRouter>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(location.search).toBe("");
  });
  it("일반 한글 검색과 필터를 유지하고 빈 값은 삭제한다", async () => {
    const { user } = setup({ q: "분기 보고", status: undefined }, "/app/agents/apps?status=active");
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(new URLSearchParams(location.search).get("q")).toBe("분기 보고");
    expect(new URLSearchParams(location.search).has("status")).toBe(false);
  });
  it("허용하지 않는 키와 보안상 민감한 키를 기록하지 않는다", async () => {
    const { user } = setup({ password: "plain-private-value", extra: "unknown", q: "정상" });
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect([...new URLSearchParams(location.search).keys()]).toEqual(["q"]);
  });
  it("서버 발급 요청 참조는 일반 자격정보 패턴과 구분해 보존한다", async () => {
    runtime.prefixes = ["req_"];
    const selected = `req_${"a".repeat(22)}.sk-${"b".repeat(18)}`;
    const { user } = setup({ selected_ref: selected }, "/app/observability/traces");
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(new URLSearchParams(location.search).get("selected_ref")).toBe(selected);
  });
});
