import { useRef, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessHarness } from "@/test/feature-access";
import { testAuth } from "@/test/auth";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { RoutingRuleDetailRoute } from "./RoutingRuleDetailRoute";
import { RoutingRuleDetailLink } from "./RoutingRuleDetailLink";
import { RoutingRuleDetailFocusContext } from "./routing-rule-detail-focus";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const row = {
  id: "분기/정산?%#",
  enabled: true,
  priority: 5,
  match_pattern: "정산-*",
  min_complexity: 10,
  max_complexity: 80,
  target_model: "정산 모델",
  target_provider: "공급자",
  note: "선택 이유",
  created_at: "2026-11-01T00:00:00Z",
};
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.103", scopes: ["routing:read"] });
});
function setup(route = "/routing/rules?page=2", handler: ApiHandler = () => ({ rules: [row] })) {
  const api = mockApi({ "GET /admin/routing-rules": handler });
  let refresh = () => {};
  function Host() {
    const focus = useRef<HTMLElement | null>(null);
    const location = useLocation(),
      navigate = useNavigate();
    const [revision, update] = useState(0);
    refresh = () => update((value) => value + 1);
    return (
      <FeatureAccessHarness featureId="routing.rules" readOnly>
        <RoutingRuleDetailFocusContext value={focus}>
          <main id="main-content" tabIndex={-1}>
            <output aria-label="현재 주소">{location.search}</output>
            <button onClick={() => void navigate(-1)}>이전 주소</button>
            <RoutingRuleDetailLink key={revision} row={row} />
            <RoutingRuleDetailRoute />
          </main>
        </RoutingRuleDetailFocusContext>
      </FeatureAccessHarness>
    );
  }
  const view = renderScreen(<Host />, { route });
  return { ...view, api, refresh: () => act(refresh) };
}
it("조회 전용 상세를 키보드로 열고 닫으면 필터와 포커스를 복원한다", async () => {
  const user = userEvent.setup();
  const view = setup();
  const link = screen.getByRole("link", { name: /규칙 상세/ });
  link.focus();
  await user.keyboard("{Enter}");
  const panel = within(await screen.findByRole("dialog", { name: "라우팅 규칙 상세" }));
  expect(await panel.findByText(row.id)).toBeVisible();
  expect(panel.getByText(row.note)).toBeVisible();
  expect(panel.queryByRole("button", { name: /저장|삭제|적용/ })).not.toBeInTheDocument();
  expect(view.api.calls.map((call) => call.options.query)).toEqual([{ id: row.id }]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(link).toHaveFocus();
  expect(screen.getByLabelText("현재 주소")).toHaveTextContent("?page=2");
  await user.click(screen.getByRole("button", { name: "이전 주소" }));
  expect(await within(await screen.findByRole("dialog")).findByText(row.id)).toBeVisible();
});
it("상세를 연 동안 목록 링크가 교체되어도 현재 규칙 링크로 초점을 돌린다", async () => {
  const user = userEvent.setup();
  const view = setup();
  const original = screen.getByRole("link", { name: /규칙 상세/ });
  await user.click(original);
  await within(await screen.findByRole("dialog")).findByText(row.id);
  view.refresh();
  expect(original.isConnected).toBe(false);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("link", { name: /규칙 상세/ })).toHaveFocus());
});
it.each([[], [{ ...row, id: "different" }], [row, row]].map((rules) => ({ rules })))(
  "없는 항목·잘못된 응답을 선택한 규칙으로 표시하지 않는다",
  async ({ rules }) => {
    setup("/routing/rules?rule_id=" + encodeURIComponent(row.id), () => ({ rules }));
    const panel = within(await screen.findByRole("dialog"));
    expect(
      await panel.findByText(rules.length ? "라우팅 규칙 상세 조회 실패" : "해당 라우팅 규칙이 없습니다."),
    ).toBeVisible();
    expect(panel.queryByText(row.target_model)).not.toBeInTheDocument();
  },
);
it("이전 서버·잘못된 중복 주소에는 상세 요청을 보내지 않는다", async () => {
  const first = setup("/routing/rules?rule_id=a&rule_id=b");
  expect(await screen.findByText("라우팅 규칙 상세 주소를 확인하세요.")).toBeVisible();
  expect(first.api.calls).toEqual([]);
  first.unmount();
  state.auth = { ...state.auth, backendVersion: "v0.86.102" };
  const second = setup("/routing/rules?rule_id=one");
  expect(await screen.findByText("서버 업데이트가 필요합니다.")).toBeVisible();
  expect(second.api.calls).toEqual([]);
});
it("권한 거부는 상세를 폐기하고 명시적 재확인만 허용한다", async () => {
  let denied = true;
  const view = setup("/routing/rules?rule_id=" + encodeURIComponent(row.id), () => {
    if (denied) throw apiFailure("denied", 403);
    return { rules: [row] };
  });
  expect(await screen.findByText("라우팅 규칙 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByText(row.note)).not.toBeInTheDocument();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "권한 다시 확인" }));
  expect(await screen.findByText(row.note)).toBeVisible();
});
it("팀 변경 뒤 이전 상세 응답은 화면과 캐시에 남지 않는다", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const view = setup("/routing/rules?rule_id=" + encodeURIComponent(row.id), () =>
    ++calls === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { rules: [] },
  );
  await waitFor(() => expect(calls).toBe(1));
  if (!state.auth.user) throw new Error("fixture user required");
  state.auth = { ...state.auth, user: { ...state.auth.user, team_id: "other" } };
  view.refresh();
  expect(await screen.findByText("해당 라우팅 규칙이 없습니다.")).toBeVisible();
  await act(async () => finish({ rules: [row] }));
  expect(screen.queryByText(row.note)).not.toBeInTheDocument();
});
