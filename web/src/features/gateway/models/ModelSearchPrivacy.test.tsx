import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { ModelToolbar } from "./ModelToolbar";

const runtime = vi.hoisted(() => ({ prefixes: ["corp_"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => ({ ...testAuth(), credentialPrefixes: runtime.prefixes }) };
});
beforeEach(() => {
  runtime.prefixes = ["corp_"];
});

function setup() {
  const update = vi.fn();
  const tree = () => (
    <MemoryRouter>
      <ModelToolbar
        onUpdate={update}
        provider=""
        providers={[]}
        query=""
        range="24h"
        status="all"
        unsafeStoredQuery={false}
      />
    </MemoryRouter>
  );
  const view = render(tree());
  return { update, refresh: () => view.rerender(tree()), user: userEvent.setup() };
}

it.each([
  ["corp_", "corp_" + "a".repeat(32)],
  ["corp_", "%63orp_" + "a".repeat(32)],
  ["%41_", "%2541_" + "b".repeat(32)],
  ["조직_", encodeURIComponent(encodeURIComponent("조직_" + "c".repeat(32)))],
])("설정 접두사 %s 검색은 주소 변경 콜백에 전달하지 않는다", async (prefix, candidate) => {
  runtime.prefixes = [prefix];
  const view = setup();
  const input = screen.getByRole("textbox", { name: "모델 검색" });
  await view.user.type(input, candidate);
  await view.user.click(screen.getByRole("button", { name: "검색" }));
  expect(view.update).not.toHaveBeenCalled();
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
  expect(screen.getByRole("alert")).not.toHaveTextContent(candidate);
});

it("제출 시점의 새 마스킹 설정을 사용하고 일반 검색으로 복구한다", async () => {
  const view = setup();
  const input = screen.getByRole("textbox", { name: "모델 검색" });
  await view.user.type(input, "next_" + "d".repeat(32));
  runtime.prefixes = ["next_"];
  view.refresh();
  fireEvent.submit(screen.getByRole("search"));
  expect(view.update).not.toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-invalid", "true");
  await view.user.clear(input);
  await view.user.type(input, "일반 모델 검색");
  await view.user.keyboard("{Enter}");
  expect(view.update).toHaveBeenCalledExactlyOnceWith({ q: "일반 모델 검색", page: undefined });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
